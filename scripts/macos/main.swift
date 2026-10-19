import AppKit
import Foundation

final class TrayApp: NSObject, NSApplicationDelegate {
    private let services: TrayController
    private let queue = DispatchQueue(label: "local-codex.services")
    private var statusItem: NSStatusItem?
    private var timer: Timer?
    private let status = NSMenuItem(title: "Local Codex", action: nil, keyEquivalent: "")
    private let pause = NSMenuItem(title: "Pause everything", action: #selector(pauseServices), keyEquivalent: "")
    private let resume = NSMenuItem(title: "Resume everything", action: #selector(resumeServices), keyEquivalent: "")
    private let tunnel = NSMenuItem(title: "Stop Cloudflare tunnel", action: #selector(toggleTunnel), keyEquivalent: "")

    init(services: TrayController) { self.services = services }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let image = Bundle.main.resourceURL.flatMap { NSImage(contentsOf: $0.appendingPathComponent("local-codex-logo.png")) }
        image?.size = NSSize(width: 18, height: 18)
        item.button?.image = image
        item.button?.setAccessibilityLabel("Local Codex")
        let menu = NSMenu()
        menu.autoenablesItems = false
        status.isEnabled = false
        menu.addItem(status)
        menu.addItem(.separator())
        for control in [pause, resume, tunnel] { control.target = self; menu.addItem(control) }
        menu.addItem(.separator())
        let logs = NSMenuItem(title: "Open logs", action: #selector(openLogs), keyEquivalent: "")
        logs.target = self
        menu.addItem(logs)
        let quit = NSMenuItem(title: "Quit Local Codex and Cloudflare", action: #selector(quitServices), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
        statusItem = item
        services.didChange = { [weak self] state in DispatchQueue.main.async { self?.update(state) } }
        update(services.state)
        queue.async { self.services.startBrowser(); self.services.sync() }
    }

    private func update(_ state: TrayState) {
        let text = state.error.map { "Local Codex - \($0)" }
            ?? (state.paused ? "Local Codex - paused" : state.tunnelEnabled ? "Local Codex - running" : "Local Codex - tunnel stopped")
        status.title = text
        statusItem?.button?.toolTip = text
        statusItem?.button?.appearsDisabled = state.paused
        pause.isEnabled = !state.paused
        resume.isEnabled = state.paused
        tunnel.isEnabled = !state.paused
        tunnel.title = state.tunnelEnabled ? "Stop Cloudflare tunnel" : "Start Cloudflare tunnel"
        if state.paused { timer?.invalidate(); timer = nil }
        else if timer == nil {
            timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
                guard let self = self else { return }
                self.queue.async { self.services.sync() }
            }
        }
    }

    private func perform(_ action: @escaping (TrayController) throws -> Void) {
        queue.async {
            do { try action(self.services) }
            catch { self.services.recordError(error) }
        }
    }

    @objc private func pauseServices() { timer?.invalidate(); timer = nil; perform { try $0.pause() } }
    @objc private func resumeServices() { perform { try $0.resume() } }
    @objc private func toggleTunnel() { perform { try $0.toggleTunnel() } }
    @objc private func openLogs() { NSWorkspace.shared.open(services.runtime) }
    @objc private func quitServices() { NSApp.terminate(nil) }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        timer?.invalidate()
        timer = nil
        queue.async {
            do {
                try self.services.pause()
                DispatchQueue.main.async { sender.reply(toApplicationShouldTerminate: true) }
            } catch {
                self.services.recordError(error)
                DispatchQueue.main.async { sender.reply(toApplicationShouldTerminate: false) }
            }
        }
        return .terminateLater
    }
}

do {
    let configurationURL = Bundle.main.resourceURL!.appendingPathComponent("configuration.json")
    let configuration = try JSONDecoder().decode(TrayConfiguration.self, from: Data(contentsOf: configurationURL))
    let services = try TrayController(configuration: configuration)
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = TrayApp(services: services)
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
} catch {
    fputs("Local Codex: \(error.localizedDescription)\n", stderr)
    exit(1)
}
