import AppKit

final class RepoNode {
    let repoKey: String
    var mrs: [MRNode] = []
    init(repoKey: String) { self.repoKey = repoKey }
}

final class MRNode {
    let key: String
    let mr: String
    var runs: [RunNode] = []
    init(key: String, mr: String) {
        self.key = key
        self.mr = mr
    }
}

final class RunNode {
    let entry: RunEntry
    init(_ entry: RunEntry) { self.entry = entry }
}

final class SidebarViewController: NSViewController, NSOutlineViewDataSource, NSOutlineViewDelegate {
    private let outline = NSOutlineView()
    private var repos: [RepoNode] = []
    private var repoByKey: [String: RepoNode] = [:]
    private var mrByKey: [String: MRNode] = [:]
    private var timer: Timer?
    private let scanner = StateScanner()
    private var isScanning = false
    private var didInitialExpand = false

    var onInspectRun: ((RunEntry) -> Void)?
    var onAttachRun: ((RunEntry) -> Void)?
    var onSelectRun: ((RunEntry?) -> Void)?
    // Suppresses selection callbacks while apply() rebuilds rows: reloadData
    // transiently clears the selection, which must not bounce the main view
    // back to the global stream on every 5s poll.
    private var isApplying = false

    override func loadView() {
        let column = NSTableColumn(identifier: .init("main"))
        column.resizingMask = .autoresizingMask
        outline.addTableColumn(column)
        outline.outlineTableColumn = column
        outline.headerView = nil
        outline.style = .sourceList
        outline.rowHeight = 22
        outline.dataSource = self
        outline.delegate = self
        outline.target = self
        outline.doubleAction = #selector(doubleClicked)
        let menu = NSMenu()
        menu.addItem(withTitle: "查看 result", action: #selector(inspectClicked), keyEquivalent: "").target = self
        outline.menu = menu

        let scroll = NSScrollView()
        scroll.documentView = outline
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        view = scroll
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    // Scans the orch state tree off-main; the mtime cache inside StateScanner
    // keeps the steady-state cost at stat() calls.
    func refresh() {
        guard !isScanning else { return }
        isScanning = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let groups = self.scanner.scan()
            DispatchQueue.main.async {
                self.isScanning = false
                self.apply(groups)
            }
        }
    }

    private func apply(_ groups: [RepoGroup]) {
        let selectedID = (outline.item(atRow: outline.selectedRow) as? RunNode)?.entry.info.run_id
        isApplying = true
        defer { isApplying = false }

        var freshRepos: [RepoNode] = []
        var seenRepos = Set<String>()
        var seenMRs = Set<String>()
        var newMRNodes: [MRNode] = []
        for group in groups {
            seenRepos.insert(group.repoKey)
            let repoNode = repoByKey[group.repoKey] ?? {
                let node = RepoNode(repoKey: group.repoKey)
                repoByKey[group.repoKey] = node
                return node
            }()
            var mrNodes: [MRNode] = []
            for mrGroup in group.mrs {
                let key = "\(group.repoKey)#\(mrGroup.mr)"
                seenMRs.insert(key)
                let mrNode: MRNode
                if let existing = mrByKey[key] {
                    mrNode = existing
                } else {
                    mrNode = MRNode(key: key, mr: mrGroup.mr)
                    mrByKey[key] = mrNode
                    newMRNodes.append(mrNode)
                }
                mrNode.runs = mrGroup.runs.map(RunNode.init)
                mrNodes.append(mrNode)
            }
            repoNode.mrs = mrNodes
            freshRepos.append(repoNode)
        }
        repoByKey = repoByKey.filter { seenRepos.contains($0.key) }
        mrByKey = mrByKey.filter { seenMRs.contains($0.key) }
        repos = freshRepos
        outline.reloadData()

        if !didInitialExpand, let first = repos.first {
            didInitialExpand = true
            outline.expandItem(first)
            if let mr = first.mrs.first { outline.expandItem(mr) }
        }
        for node in newMRNodes where didInitialExpand {
            outline.expandItem(node)
        }

        // Restore the selection onto the recreated RunNode and hand the main
        // view the FRESH entry (state may have changed → cancel button).
        var reselected: RunEntry?
        if let selectedID {
            outer: for repo in repos {
                for mrNode in repo.mrs {
                    for runNode in mrNode.runs where runNode.entry.info.run_id == selectedID {
                        let row = outline.row(forItem: runNode)
                        if row >= 0 {
                            outline.selectRowIndexes([row], byExtendingSelection: false)
                            reselected = runNode.entry
                        }
                        break outer
                    }
                }
            }
        }
        onSelectRun?(reselected)
    }

    // Double-click attaches the input box to the run's provider session;
    // result inspection moved to the context menu.
    @objc private func doubleClicked() {
        guard let node = outline.item(atRow: outline.clickedRow) as? RunNode else { return }
        onAttachRun?(node.entry)
    }

    @objc private func inspectClicked() {
        guard let node = outline.item(atRow: outline.clickedRow) as? RunNode else { return }
        onInspectRun?(node.entry)
    }

    func outlineViewSelectionDidChange(_ notification: Notification) {
        guard !isApplying else { return }
        onSelectRun?((outline.item(atRow: outline.selectedRow) as? RunNode)?.entry)
    }

    // MARK: NSOutlineViewDataSource

    func outlineView(_ v: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
        if item == nil { return repos.count }
        if let repo = item as? RepoNode { return repo.mrs.count }
        return (item as? MRNode)?.runs.count ?? 0
    }

    func outlineView(_ v: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
        if let repo = item as? RepoNode { return repo.mrs[index] }
        if let mr = item as? MRNode { return mr.runs[index] }
        return repos[index]
    }

    func outlineView(_ v: NSOutlineView, isItemExpandable item: Any) -> Bool {
        if let repo = item as? RepoNode { return !repo.mrs.isEmpty }
        if let mr = item as? MRNode { return !mr.runs.isEmpty }
        return false
    }

    // MARK: NSOutlineViewDelegate

    // Rows are strictly single-line: state renders as the colored dot only,
    // with the textual state in the tooltip.
    func outlineView(_ v: NSOutlineView, viewFor c: NSTableColumn?, item: Any) -> NSView? {
        let label = NSTextField(labelWithString: "")
        label.maximumNumberOfLines = 1
        label.cell?.usesSingleLineMode = true
        label.cell?.wraps = false
        label.lineBreakMode = .byTruncatingTail
        label.allowsDefaultTighteningForTruncation = true
        // attributedStringValue overrides the label's line-break mode; carry
        // it in the string's own paragraph style.
        let para = NSMutableParagraphStyle()
        para.lineBreakMode = .byTruncatingTail

        if let repo = item as? RepoNode {
            label.font = .systemFont(ofSize: 11, weight: .bold)
            label.textColor = .secondaryLabelColor
            label.stringValue = repo.repoKey.components(separatedBy: "/").last ?? repo.repoKey
            label.toolTip = repo.repoKey
        } else if let node = item as? MRNode {
            let text = NSMutableAttributedString()
            text.append(NSAttributedString(string: node.mr, attributes: [
                .foregroundColor: NSColor.labelColor,
                .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
                .paragraphStyle: para,
            ]))
            text.append(NSAttributedString(string: "  \(node.runs.count)", attributes: [
                .foregroundColor: NSColor.tertiaryLabelColor,
                .font: NSFont.systemFont(ofSize: 11),
                .paragraphStyle: para,
            ]))
            label.attributedStringValue = text
            label.toolTip = node.mr
        } else if let node = item as? RunNode {
            let info = node.entry.info
            let text = NSMutableAttributedString()
            text.append(NSAttributedString(string: "● ", attributes: [
                .foregroundColor: Self.stateColor(info.state),
                .font: NSFont.systemFont(ofSize: 12),
                .paragraphStyle: para,
            ]))
            text.append(NSAttributedString(string: "\(info.role) · \(info.agent)", attributes: [
                .foregroundColor: NSColor.labelColor,
                .font: NSFont.systemFont(ofSize: 12),
                .paragraphStyle: para,
            ]))
            var detail = ""
            let when = relativeTime(info.updated_at)
            if !when.isEmpty { detail += "  \(when)" }
            if let decision = node.entry.decision {
                detail += " " + (decision == "accept" ? "✓" : decision == "rework" ? "↻" : "✕")
            }
            if !detail.isEmpty {
                text.append(NSAttributedString(string: detail, attributes: [
                    .foregroundColor: NSColor.secondaryLabelColor,
                    .font: NSFont.systemFont(ofSize: 11),
                    .paragraphStyle: para,
                ]))
            }
            label.attributedStringValue = text
            var tip = "\(info.run_id)\n\(info.state)"
            if !when.isEmpty { tip += " · \(when)" }
            if let decision = node.entry.decision { tip += " · \(decision)" }
            label.toolTip = tip
        }

        let cell = NSTableCellView()
        cell.addSubview(label)
        cell.textField = label
        label.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 2),
            label.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -2),
            label.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
        ])
        return cell
    }

    static func stateColor(_ state: String) -> NSColor {
        switch state {
        case "done": return .systemGreen
        case "failed", "timeout": return .systemRed
        case "running", "pending", "starting": return .systemOrange
        case "canceled": return .systemGray
        default: return .secondaryLabelColor
        }
    }
}
