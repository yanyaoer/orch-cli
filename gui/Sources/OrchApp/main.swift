import AppKit

/// Thin strip pinned to the window's left edge, live only while the sidebar
/// is collapsed: a fully collapsed NSSplitView divider sits at x=0 and cannot
/// be grabbed again, so approaching the edge re-summons the sidebar (the real
/// divider then sits under the cursor for further dragging).
final class EdgeRevealView: NSView {
    var onHover: (() -> Void)?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds,
                                       options: [.mouseEnteredAndExited, .activeInKeyWindow],
                                       owner: self, userInfo: nil))
    }

    override func mouseEntered(with event: NSEvent) {
        onHover?()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private let sidebar = SidebarViewController()
    private let main = MainViewController()
    private var sideItem: NSSplitViewItem!
    private let edgeReveal = EdgeRevealView()
    private var collapseObservation: NSKeyValueObservation?

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.mainMenu = Self.buildMenu()

        main.onRunsChanged = { [weak self] in self?.sidebar.refresh() }
        sidebar.onInspectRun = { [weak self] run in self?.main.inspectRun(run) }
        sidebar.onAttachRun = { [weak self] run in self?.main.attachRun(run) }
        sidebar.onSelectRun = { [weak self] run in self?.main.selectRun(run) }

        let split = NSSplitViewController()
        sideItem = NSSplitViewItem(sidebarWithViewController: sidebar)
        sideItem.minimumThickness = 220
        sideItem.maximumThickness = 420
        split.addSplitViewItem(sideItem)
        split.addSplitViewItem(NSSplitViewItem(viewController: main))

        window = NSWindow(contentViewController: split)
        window.title = "orch"
        window.setContentSize(NSSize(width: 1080, height: 700))
        window.minSize = NSSize(width: 720, height: 480)
        window.center()

        if let content = window.contentView {
            edgeReveal.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview(edgeReveal, positioned: .above, relativeTo: nil)
            NSLayoutConstraint.activate([
                edgeReveal.leadingAnchor.constraint(equalTo: content.leadingAnchor),
                edgeReveal.topAnchor.constraint(equalTo: content.topAnchor),
                edgeReveal.bottomAnchor.constraint(equalTo: content.bottomAnchor),
                edgeReveal.widthAnchor.constraint(equalToConstant: 10),
            ])
        }
        edgeReveal.onHover = { [weak self] in
            guard let item = self?.sideItem, item.isCollapsed else { return }
            item.animator().isCollapsed = false
        }
        collapseObservation = sideItem.observe(\.isCollapsed, options: [.initial, .new]) { [weak self] item, _ in
            self?.edgeReveal.isHidden = !item.isCollapsed
        }

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ note: Notification) {
        main.stopAll()
    }

    private static func buildMenu() -> NSMenu {
        let menu = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit orch",
                        action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All",
                     action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        menu.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "View")
        let toggle = NSMenuItem(title: "Toggle Sidebar",
                                action: #selector(NSSplitViewController.toggleSidebar(_:)),
                                keyEquivalent: "s")
        toggle.keyEquivalentModifierMask = [.command, .control]
        view.addItem(toggle)
        viewItem.submenu = view
        menu.addItem(viewItem)

        return menu
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
