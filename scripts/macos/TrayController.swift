import CryptoKit
import Darwin
import Foundation

struct TrayConfiguration: Codable {
    let connectorDirectory: String
    let nodeExecutable: String
    let cloudflaredExecutable: String
    let tunnelName: String
}

struct TrayState {
    let paused: Bool
    let tunnelEnabled: Bool
    let error: String?
}

enum TrayError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let message): return message }
    }
}

// All operations run on the app's single service queue.
final class TrayController {
    let root: URL
    let runtime: URL
    private let configuration: TrayConfiguration
    private let installationID: String
    private let healthURL: URL
    private let port: Int
    private let lock: Int32
    private var serverPID: Int32?
    private var tunnelPID: Int32?
    private var children: [Int32: Process] = [:]
    private(set) var paused: Bool
    private(set) var tunnelEnabled: Bool
    private(set) var lastError: String?
    var didChange: ((TrayState) -> Void)?

    init(configuration: TrayConfiguration) throws {
        self.configuration = configuration
        root = URL(fileURLWithPath: configuration.connectorDirectory).resolvingSymlinksInPath()
        runtime = root.appendingPathComponent(".data/runtime")
        installationID = SHA256.hash(data: Data(root.path.utf8)).map { String(format: "%02x", $0) }.joined()
        guard configuration.tunnelName.range(of: "^[a-zA-Z0-9_-]+$", options: .regularExpression) != nil else {
            throw TrayError.message("The tunnel name must be a name or UUID.")
        }
        var host = "localhost"
        var configuredPort = 6000
        let environment = try String(contentsOf: root.appendingPathComponent(".env"), encoding: .utf8)
        for line in environment.components(separatedBy: .newlines) {
            let parts = line.split(separator: "=", maxSplits: 1).map { String($0).trimmingCharacters(in: .whitespaces) }
            guard parts.count == 2 else { continue }
            let value = parts[1].components(separatedBy: "#")[0]
                .trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
            if parts[0] == "HOST" { host = value }
            if parts[0] == "PORT" {
                guard let value = Int(value), (1...65535).contains(value) else { throw TrayError.message("Invalid PORT in .env.") }
                configuredPort = value
            }
        }
        port = configuredPort
        var address = URLComponents()
        address.scheme = "http"
        address.host = host == "0.0.0.0" ? "127.0.0.1" : host == "::" ? "::1" : host
        address.port = port
        address.path = "/health"
        guard let url = address.url else { throw TrayError.message("Invalid HOST in .env.") }
        healthURL = url
        try FileManager.default.createDirectory(at: runtime, withIntermediateDirectories: true)
        paused = FileManager.default.fileExists(atPath: runtime.appendingPathComponent("paused").path)
        tunnelEnabled = !FileManager.default.fileExists(atPath: runtime.appendingPathComponent("tunnel-disabled").path)
        lock = Darwin.open(runtime.appendingPathComponent("menubar.lock").path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard lock >= 0 else { throw TrayError.message("Cannot open the menu bar lock.") }
        guard flock(lock, LOCK_EX | LOCK_NB) == 0 else {
            Darwin.close(lock)
            throw TrayError.message("Local Codex is already in the menu bar for this installation.")
        }
    }

    deinit { flock(lock, LOCK_UN); Darwin.close(lock) }

    var state: TrayState { TrayState(paused: paused, tunnelEnabled: tunnelEnabled, error: lastError) }

    private func log(_ message: String) {
        let url = runtime.appendingPathComponent("watchdog.log")
        if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
        guard let handle = try? FileHandle(forWritingTo: url) else { return }
        defer { try? handle.close() }
        do {
            try handle.seekToEnd()
            try handle.write(contentsOf: Data("\(ISO8601DateFormatter().string(from: Date())) \(message)\n".utf8))
        } catch { }
    }

    private func setMarker(_ name: String, exists: Bool) throws {
        let url = runtime.appendingPathComponent(name)
        if exists { try Data().write(to: url, options: .atomic) }
        else if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }

    func recordError(_ error: Error) {
        let message = error.localizedDescription
        if lastError != message { log("Startup or recovery failed: \(message)") }
        lastError = message
        didChange?(state)
    }

    private func output(_ executable: String, _ arguments: [String]) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 || process.terminationStatus == 1 else {
            throw TrayError.message("\(executable) exited with status \(process.terminationStatus).")
        }
        return String(decoding: data, as: UTF8.self)
    }

    private func executableMatches(_ pid: Int32, _ executable: String) throws -> Bool {
        let expected = URL(fileURLWithPath: executable).resolvingSymlinksInPath().path
        let files = try output("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"])
        return files.components(separatedBy: .newlines).contains("n" + expected)
    }

    private func alive(_ pid: Int32?) -> Bool {
        guard let pid = pid else { return false }
        if let child = children[pid] { return child.isRunning }
        return Darwin.kill(pid, 0) == 0
    }

    @discardableResult
    private func start(_ executable: String, _ arguments: [String], name: String) throws -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.currentDirectoryURL = root
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = [URL(fileURLWithPath: configuration.nodeExecutable).deletingLastPathComponent().path,
            URL(fileURLWithPath: configuration.cloudflaredExecutable).deletingLastPathComponent().path,
            "/opt/homebrew/bin", "/usr/local/bin", environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"].joined(separator: ":")
        process.environment = environment
        var handles: [FileHandle] = []
        defer { for handle in handles { try? handle.close() } }
        for suffix in ["stdout", "stderr"] {
            let url = runtime.appendingPathComponent("\(name).\(suffix).log")
            if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
            let handle = try FileHandle(forWritingTo: url)
            try handle.seekToEnd()
            handles.append(handle)
        }
        process.standardOutput = handles[0]
        process.standardError = handles[1]
        try process.run()
        children[process.processIdentifier] = process
        log("Started \(name) PID \(process.processIdentifier).")
        return process.processIdentifier
    }

    private func stop(_ pid: Int32?, executable: String) throws {
        guard let pid = pid, alive(pid) else { return }
        guard try executableMatches(pid, executable) else { throw TrayError.message("Process \(pid) changed. It has been left running.") }
        guard Darwin.kill(pid, SIGTERM) == 0 else { throw TrayError.message("Cannot stop process \(pid).") }
        let deadline = Date().addingTimeInterval(12)
        while alive(pid) && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
        if alive(pid) { throw TrayError.message("Process \(pid) did not stop. See the runtime logs.") }
        children.removeValue(forKey: pid)
        log("Stopped process PID \(pid).")
    }

    private struct Health: Decodable {
        let ok: Bool
        let name: String
        let installationId: String?
        let pid: Int32?
    }

    private func health() -> Health? {
        // curl has a strict deadline and does not block AppKit's main thread.
        guard let response = try? output("/usr/bin/curl", ["--silent", "--fail", "--noproxy", "*", "--max-time", "2", healthURL.absoluteString]) else { return nil }
        return try? JSONDecoder().decode(Health.self, from: Data(response.utf8))
    }

    func sync() {
        defer { didChange?(state) }
        guard !paused else { return }
        do {
            children = children.filter { $0.value.isRunning }
            let listeners = Set(try output("/usr/sbin/lsof", ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-t"])
                .split(whereSeparator: \.isNewline).compactMap { Int32($0) })
            let status = health()
            if status?.ok == true && status?.name == "local-codex" {
                if !alive(serverPID) {
                    guard status?.installationId == installationID, let pid = status?.pid, listeners.contains(pid),
                          try executableMatches(pid, configuration.nodeExecutable) else {
                        throw TrayError.message("Port \(port) belongs to another or older installation. Its server has been left running.")
                    }
                    serverPID = pid
                    log("Adopted existing MCP server PID \(pid).")
                }
            } else if !alive(serverPID) {
                guard listeners.isEmpty else { throw TrayError.message("Port \(port) is occupied. The existing process has been left running.") }
                serverPID = try start(configuration.nodeExecutable, ["dist/server.js"], name: "server")
            }
            if tunnelEnabled && !alive(tunnelPID) {
                let processes = try output("/bin/ps", ["-axo", "pid=,command="]).components(separatedBy: .newlines)
                let suffix = " tunnel run " + configuration.tunnelName
                let candidates = processes.compactMap { line -> Int32? in
                    let parts = line.trimmingCharacters(in: .whitespaces).split(maxSplits: 1, whereSeparator: \.isWhitespace)
                    guard parts.count == 2, String(parts[1]).hasSuffix(suffix) else { return nil }
                    return Int32(parts[0])
                }
                if !candidates.isEmpty {
                    guard candidates.count == 1, let pid = candidates.first,
                          try executableMatches(pid, configuration.cloudflaredExecutable) else {
                        throw TrayError.message("Cannot verify the existing Cloudflare tunnel. It has been left running.")
                    }
                    tunnelPID = pid
                    log("Adopted existing Cloudflare tunnel PID \(pid).")
                } else {
                    tunnelPID = try start(configuration.cloudflaredExecutable, ["tunnel", "run", configuration.tunnelName], name: "tunnel")
                }
            }
            lastError = nil
        } catch { recordError(error) }
    }

    func pause() throws {
        try setMarker("paused", exists: true)
        paused = true
        defer { didChange?(state) }
        var failures: [String] = []
        do { try stop(tunnelPID, executable: configuration.cloudflaredExecutable); tunnelPID = nil } catch { failures.append(error.localizedDescription) }
        do { try stop(serverPID, executable: configuration.nodeExecutable); serverPID = nil } catch { failures.append(error.localizedDescription) }
        if !failures.isEmpty { throw TrayError.message(failures.joined(separator: "\n")) }
        lastError = nil
        log("Paused. Server, tunnel, and recovery checks are stopped.")
    }

    func resume() throws {
        try setMarker("paused", exists: false)
        paused = false
        sync()
    }

    func toggleTunnel() throws {
        guard !paused else { return }
        try setMarker("tunnel-disabled", exists: tunnelEnabled)
        tunnelEnabled.toggle()
        if !tunnelEnabled { try stop(tunnelPID, executable: configuration.cloudflaredExecutable); tunnelPID = nil }
        sync()
    }

    func startBrowser() {
        guard !paused else { return }
        do { try start(configuration.nodeExecutable, ["scripts/start-browser.mjs"], name: "browser") }
        catch { log("Browser startup failed: \(error.localizedDescription)") }
    }
}
