import Darwin
import Foundation

@main
struct TrayControllerTests {
    private struct HealthPID: Decodable { let pid: Int32 }
    static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw TrayError.message(message) }
    }

    static func launch(_ executable: String, _ arguments: [String], root: URL) throws -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.currentDirectoryURL = root
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.standardError
        try process.run()
        return process
    }

    static func main() throws {
        let configURL = URL(fileURLWithPath: CommandLine.arguments[1])
        let config = try JSONDecoder().decode(TrayConfiguration.self, from: Data(contentsOf: configURL))
        let root = URL(fileURLWithPath: config.connectorDirectory)
        let marker = root.appendingPathComponent(".data/runtime/paused")
        let foreignMarker = root.appendingPathComponent("foreign")
        try FileManager.default.createDirectory(at: marker.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data().write(to: marker)
        var external: [Process] = []
        let services = try TrayController(configuration: config)
        defer {
            try? services.pause()
            for process in external where process.isRunning { process.terminate(); process.waitUntilExit() }
        }
        // The lock is owned by the controller, not by a PID file that can become stale.
        do {
            _ = try TrayController(configuration: config)
            throw TrayError.message("A duplicate menu bar controller acquired the same installation.")
        } catch let error as TrayError {
            try require(error.localizedDescription.contains("already in the menu bar"), error.localizedDescription)
        }
        let server = try launch(config.nodeExecutable, ["dist/server.js"], root: root)
        external.append(server)
        let tunnel = try launch(config.cloudflaredExecutable, ["tunnel", "run", config.tunnelName], root: root)
        external.append(tunnel)
        Thread.sleep(forTimeInterval: 1)
        try services.resume()
        try require(services.state.error == nil, services.state.error ?? "Adoption failed.")
        try require(server.isRunning && tunnel.isRunning, "Adoption replaced a running process.")
        try services.pause()
        server.waitUntilExit()
        tunnel.waitUntilExit()
        try require(!server.isRunning && !tunnel.isRunning, "Pause did not stop adopted processes.")
        try require(FileManager.default.fileExists(atPath: marker.path), "Pause was not persisted.")
        services.sync()
        try require(services.state.paused, "Recovery resumed paused services.")
        try services.resume()
        Thread.sleep(forTimeInterval: 1)
        services.sync()
        try require(services.state.error == nil, services.state.error ?? "Restart failed.")
        try services.toggleTunnel()
        try require(!services.state.tunnelEnabled, "The tunnel did not stop independently.")
        try services.toggleTunnel()
        try require(services.state.tunnelEnabled && services.state.error == nil, "The tunnel did not restart.")
        let healthProcess = Process()
        healthProcess.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        healthProcess.arguments = ["--silent", "--fail", "--max-time", "2", "http://127.0.0.1:\(CommandLine.arguments[2])/health"]
        let response = Pipe()
        healthProcess.standardOutput = response
        try healthProcess.run()
        let health = try JSONDecoder().decode(HealthPID.self, from: response.fileHandleForReading.readDataToEndOfFile())
        healthProcess.waitUntilExit()
        let crashedPID = health.pid
        Darwin.kill(crashedPID, SIGKILL)
        Thread.sleep(forTimeInterval: 0.3)
        services.sync()
        Thread.sleep(forTimeInterval: 1)
        services.sync()
        try require(services.state.error == nil, services.state.error ?? "Crash recovery failed.")
        // Keep the independently disabled tunnel setting across a full pause and resume.
        try services.toggleTunnel()
        try services.pause()
        try Data().write(to: foreignMarker)
        let foreign = try launch(config.nodeExecutable, ["dist/server.js"], root: root)
        external.append(foreign)
        Thread.sleep(forTimeInterval: 1)
        try services.resume()
        services.sync()
        try require(services.state.error != nil && foreign.isRunning, "Another installation was adopted or stopped.")
        let log = try String(contentsOf: root.appendingPathComponent(".data/runtime/watchdog.log"), encoding: .utf8)
        try require(log.components(separatedBy: "Startup or recovery failed:").count - 1 == 1, "An unchanged error was logged repeatedly.")
        try services.pause()
        try require(foreign.isRunning, "Pause stopped another installation.")
        foreign.terminate()
        foreign.waitUntilExit()
        try FileManager.default.removeItem(at: foreignMarker)
        try services.resume()
        Thread.sleep(forTimeInterval: 1)
        services.sync()
        try require(services.state.error == nil, "Recovery did not clear the previous error.")
        try services.pause()
        // Read persisted state independently without releasing the active instance's lock.
        try require(FileManager.default.fileExists(atPath: root.appendingPathComponent(".data/runtime/tunnel-disabled").path), "The separate tunnel setting was lost.")
        print("PASS: macOS singleton, existing server and tunnel adoption, pause/resume, tunnel toggle, crash recovery, persistence, foreign installation preservation, error suppression and recovery.")
    }
}
