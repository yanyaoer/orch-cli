import Foundation

struct Workspace: Decodable {
    let id: String
    let path: String
}

struct RunInfo: Decodable {
    let run_id: String
    let mr: String
    let role: String
    let agent: String
    let state: String
    let updated_at: String?
    let exit_code: Int?
    let worktree: String?
    let tag: String?
    let provider_resume_id: String?
    let provider_session_id: String?
    let provider_session_mode: String?
}

struct RunEntry {
    let info: RunInfo
    let runDir: String
    let decision: String?
}

struct MRGroup {
    let repoKey: String
    let mr: String
    var runs: [RunEntry]
    var latest: String
}

struct RepoGroup {
    let repoKey: String
    var mrs: [MRGroup]
    var latest: String
}

// Reads run records straight from the orch state tree
// (${XDG_STATE_HOME:-~/.local/state}/orch/<repo_key>/mrs/<mr>/runs/<run_id>/)
// instead of shelling out to `orch status`: every repo shows up regardless of
// the selected workspace, records survive deleted worktrees, and one
// malformed status.json skips a single row instead of blanking the tree.
final class StateScanner {
    static var stateRoot: String {
        let env = ProcessInfo.processInfo.environment
        let base = env["XDG_STATE_HOME"] ?? NSHomeDirectory() + "/.local/state"
        return base + "/orch"
    }

    // Non-repo bookkeeping dirs at the state root.
    private static let skippedRootDirs: Set<String> = [
        "dispatch", "worktree-locks", "mail", "mail-control", "chatgpt-bridge-locks",
    ]

    private struct CachedEntry {
        let statusMtime: Date
        let decisionMtime: Date?
        let entry: RunEntry
    }

    private var cache: [String: CachedEntry] = [:]
    private let fm = FileManager.default

    func scan() -> [RepoGroup] {
        var repos: [RepoGroup] = []
        for repoKey in findRepoKeys() {
            let mrsDir = "\(Self.stateRoot)/\(repoKey)/mrs"
            var groups: [MRGroup] = []
            for mr in (try? fm.contentsOfDirectory(atPath: mrsDir)) ?? [] {
                let runsDir = "\(mrsDir)/\(mr)/runs"
                var runs: [RunEntry] = []
                for runID in (try? fm.contentsOfDirectory(atPath: runsDir)) ?? [] {
                    if let entry = runEntry(runDir: "\(runsDir)/\(runID)") { runs.append(entry) }
                }
                guard !runs.isEmpty else { continue }
                runs.sort { ($0.info.updated_at ?? "") > ($1.info.updated_at ?? "") }
                let latest = runs.compactMap(\.info.updated_at).max() ?? ""
                groups.append(MRGroup(repoKey: repoKey, mr: mr, runs: runs, latest: latest))
            }
            guard !groups.isEmpty else { continue }
            groups.sort { $0.latest > $1.latest }
            repos.append(RepoGroup(repoKey: repoKey, mrs: groups, latest: groups.first?.latest ?? ""))
        }
        repos.sort { $0.latest > $1.latest }
        return repos
    }

    // Repo keys are nested paths (e.g. git.n.xiaomi.com/ai-framework/x-abc123):
    // walk down until a directory containing "mrs" appears.
    private func findRepoKeys() -> [String] {
        var keys: [String] = []
        func walk(_ dir: String, _ rel: String, depth: Int) {
            guard depth <= 4 else { return }
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: "\(dir)/mrs", isDirectory: &isDir), isDir.boolValue {
                keys.append(rel)
                return
            }
            for name in (try? fm.contentsOfDirectory(atPath: dir)) ?? [] {
                if depth == 0 && Self.skippedRootDirs.contains(name) { continue }
                var sub: ObjCBool = false
                let path = "\(dir)/\(name)"
                if fm.fileExists(atPath: path, isDirectory: &sub), sub.boolValue {
                    walk(path, rel.isEmpty ? name : "\(rel)/\(name)", depth: depth + 1)
                }
            }
        }
        walk(Self.stateRoot, "", depth: 0)
        return keys
    }

    private func mtime(_ path: String) -> Date? {
        (try? fm.attributesOfItem(atPath: path))?[.modificationDate] as? Date
    }

    private func runEntry(runDir: String) -> RunEntry? {
        let statusPath = "\(runDir)/status.json"
        guard let statusM = mtime(statusPath) else { return nil }
        let decisionPath = "\(runDir)/decision.json"
        let decisionM = mtime(decisionPath)
        if let cached = cache[runDir], cached.statusMtime == statusM, cached.decisionMtime == decisionM {
            return cached.entry
        }
        guard let data = fm.contents(atPath: statusPath),
              let info = try? JSONDecoder().decode(RunInfo.self, from: data) else { return nil }
        struct Decision: Decodable { let verdict: String? }
        var verdict: String?
        if decisionM != nil, let d = fm.contents(atPath: decisionPath) {
            verdict = (try? JSONDecoder().decode(Decision.self, from: d))?.verdict
        }
        let entry = RunEntry(info: info, runDir: runDir, decision: verdict)
        cache[runDir] = CachedEntry(statusMtime: statusM, decisionMtime: decisionM, entry: entry)
        return entry
    }
}

// MARK: - native.jsonl reading / rendering

struct NativeTail {
    let lines: [String]
    /// Byte offset of the first returned line — where backward history
    /// paging continues from.
    let startOffset: UInt64
    let endOffset: UInt64
}

enum NativeLog {
    /// Complete lines of a chunk with their absolute byte offsets; a chunk cut
    /// mid-file drops its leading partial line (the preceding chunk read later
    /// will contain it whole).
    private static func completeLines(_ data: Data, base: UInt64, dropFirstPartial: Bool) -> [(offset: UInt64, text: String)] {
        let bytes = [UInt8](data)
        var result: [(UInt64, String)] = []
        var lineStart = 0
        var usable = !dropFirstPartial
        for i in 0..<bytes.count where bytes[i] == 0x0A {
            if usable {
                if i > lineStart {
                    result.append((base + UInt64(lineStart), String(decoding: bytes[lineStart..<i], as: UTF8.self)))
                }
            } else {
                usable = true
            }
            lineStart = i + 1
        }
        if usable, lineStart < bytes.count {
            result.append((base + UInt64(lineStart), String(decoding: bytes[lineStart...], as: UTF8.self)))
        }
        return result
    }

    /// Last `count` complete lines of a (possibly huge) jsonl file, reading at
    /// most `maxBytes` from the end; endOffset lets a tailer continue live.
    static func tail(path: String, count: Int, maxBytes: UInt64 = 262_144) -> NativeTail? {
        guard let fh = FileHandle(forReadingAtPath: path) else { return nil }
        defer { try? fh.close() }
        guard let size = try? fh.seekToEnd() else { return nil }
        let start = size > maxBytes ? size - maxBytes : 0
        try? fh.seek(toOffset: start)
        guard let data = try? fh.readToEnd() else { return NativeTail(lines: [], startOffset: size, endOffset: size) }
        let lines = completeLines(data, base: start, dropFirstPartial: start > 0)
        let kept = Array(lines.suffix(count))
        return NativeTail(lines: kept.map(\.text), startOffset: kept.first?.offset ?? size, endOffset: size)
    }

    /// One chunk of history immediately BEFORE byte `upTo` (which must be a
    /// line start): returns older complete lines and the new window start.
    static func chunkBefore(path: String, upTo: UInt64, maxBytes: UInt64 = 262_144) -> (lines: [String], startOffset: UInt64)? {
        guard upTo > 0, let fh = FileHandle(forReadingAtPath: path) else { return nil }
        defer { try? fh.close() }
        let start = upTo > maxBytes ? upTo - maxBytes : 0
        try? fh.seek(toOffset: start)
        guard let data = try? fh.read(upToCount: Int(upTo - start)), !data.isEmpty else { return nil }
        let lines = completeLines(data, base: start, dropFirstPartial: start > 0)
        return (lines.map(\.text), lines.first?.offset ?? start)
    }

    // Keys worth surfacing, in display priority; everything else in a native
    // event is machinery.
    private static let priorityKeys = [
        "title", "text", "message", "summary", "command", "error",
        "result", "recommendation", "content", "name", "path", "state", "reason",
    ]

    /// Provider-agnostic one-line summary of a native event: parse the JSON
    /// and surface the human-relevant strings (parsing also resolves the
    /// escaped-blob soup a raw dump shows).
    static func summarize(_ line: String) -> (tag: String, text: String) {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return ("raw", clip(line, 300))
        }
        let tag = (obj["type"] as? String) ?? (obj["kind"] as? String) ?? "event"
        var parts: [String] = []
        collect(obj, depth: 0, parts: &parts)
        return (tag, clip(parts.joined(separator: " · "), 500))
    }

    private static func collect(_ any: Any, depth: Int, parts: inout [String]) {
        guard depth < 5, parts.count < 4 else { return }
        if let dict = any as? [String: Any] {
            for key in priorityKeys {
                guard parts.count < 4 else { return }
                if let s = dict[key] as? String {
                    let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmed.isEmpty { parts.append(clip(trimmed.replacingOccurrences(of: "\n", with: " ⏎ "), 200)) }
                }
            }
            for key in dict.keys.sorted() {
                guard parts.count < 4 else { return }
                let value = dict[key]
                if value is [String: Any] || value is [Any] {
                    collect(value as Any, depth: depth + 1, parts: &parts)
                }
            }
        } else if let arr = any as? [Any] {
            for value in arr {
                guard parts.count < 4 else { return }
                collect(value, depth: depth + 1, parts: &parts)
            }
        }
    }

    static func clip(_ s: String, _ n: Int) -> String {
        s.count <= n ? s : String(s.prefix(n)) + " …"
    }
}

/// Follows appended bytes of a file by offset polling (1s): native.jsonl has
/// no writer notification we can subscribe to without extra machinery.
final class FileTailer {
    private let path: String
    private var offset: UInt64
    private var carry = Data()
    private var timer: Timer?
    private let onLine: (String) -> Void

    init(path: String, offset: UInt64, onLine: @escaping (String) -> Void) {
        self.path = path
        self.offset = offset
        self.onLine = onLine
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            self?.poll()
        }
    }

    private func poll() {
        guard let fh = FileHandle(forReadingAtPath: path) else { return }
        defer { try? fh.close() }
        guard let size = try? fh.seekToEnd(), size > offset else { return }
        try? fh.seek(toOffset: offset)
        guard let data = try? fh.readToEnd() else { return }
        offset = size
        carry.append(data)
        while let nl = carry.firstIndex(of: 0x0A) {
            let lineData = carry.subdata(in: carry.startIndex..<nl)
            carry = carry.subdata(in: carry.index(after: nl)..<carry.endIndex)
            if !lineData.isEmpty { onLine(String(decoding: lineData, as: UTF8.self)) }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }
}

func relativeTime(_ iso: String?) -> String {
    guard let iso else { return "" }
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = parser.date(from: iso) ?? {
        parser.formatOptions = [.withInternetDateTime]
        return parser.date(from: iso)
    }()
    guard let date else { return "" }
    let s = Int(-date.timeIntervalSinceNow)
    if s < 60 { return "\(max(s, 0))s" }
    if s < 3600 { return "\(s / 60)m" }
    if s < 86400 { return "\(s / 3600)h" }
    return "\(s / 86400)d"
}

enum Orch {
    static let binary: String = {
        let local = ("~/.local/bin/orch" as NSString).expandingTildeInPath
        return FileManager.default.isExecutableFile(atPath: local) ? local : ""
    }()

    static func process(_ args: [String], cwd: String? = nil) -> Process {
        let p = Process()
        if binary.isEmpty {
            p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            p.arguments = ["orch"] + args
        } else {
            p.executableURL = URL(fileURLWithPath: binary)
            p.arguments = args
        }
        var env = ProcessInfo.processInfo.environment
        let home = NSHomeDirectory()
        env["PATH"] = "\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:"
            + (env["PATH"] ?? "/usr/bin:/bin")
        p.environment = env
        if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        p.standardInput = FileHandle.nullDevice
        return p
    }

    /// Run to completion off-main; callback on main with (stdout, errorMessage).
    static func capture(_ args: [String], cwd: String? = nil,
                        completion: @escaping (Data?, String?) -> Void) {
        DispatchQueue.global().async {
            let p = process(args, cwd: cwd)
            let out = Pipe(), err = Pipe()
            p.standardOutput = out
            p.standardError = err
            do { try p.run() } catch {
                DispatchQueue.main.async { completion(nil, "无法启动 orch: \(error.localizedDescription)") }
                return
            }
            // read both pipes concurrently so a full stderr buffer can't deadlock the child
            let group = DispatchGroup()
            var outData = Data(), errData = Data()
            group.enter()
            DispatchQueue.global().async {
                outData = out.fileHandleForReading.readDataToEndOfFile()
                group.leave()
            }
            group.enter()
            DispatchQueue.global().async {
                errData = err.fileHandleForReading.readDataToEndOfFile()
                group.leave()
            }
            group.wait()
            p.waitUntilExit()
            DispatchQueue.main.async {
                if p.terminationStatus == 0 {
                    completion(outData, nil)
                } else {
                    let msg = String(data: errData, encoding: .utf8) ?? ""
                    completion(nil, "orch \(args.joined(separator: " ")) 退出码 \(p.terminationStatus)\n\(msg)")
                }
            }
        }
    }
}

/// Forwards a pipe's bytes as UTF-8 text, holding back incomplete trailing sequences.
final class PipeReader {
    private var carry = Data()

    init(_ pipe: Pipe, onText: @escaping (String) -> Void) {
        pipe.fileHandleForReading.readabilityHandler = { [self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            carry.append(data)
            if let s = String(data: carry, encoding: .utf8) {
                carry.removeAll()
                DispatchQueue.main.async { onText(s) }
            } else {
                for cut in 1...3 where carry.count > cut {
                    if let s = String(data: carry.prefix(carry.count - cut), encoding: .utf8) {
                        carry.removeFirst(carry.count - cut)
                        DispatchQueue.main.async { onText(s) }
                        break
                    }
                }
            }
        }
    }
}

/// One long-running orch child process with stdout+stderr streamed as text.
final class StreamTask {
    let process: Process
    private var readers: [PipeReader] = []

    var isRunning: Bool { process.isRunning }

    init?(_ args: [String], cwd: String? = nil,
          onText: @escaping (String) -> Void,
          onExit: ((Int32) -> Void)? = nil) {
        process = Orch.process(args, cwd: cwd)
        let out = Pipe(), err = Pipe()
        process.standardOutput = out
        process.standardError = err
        readers = [PipeReader(out, onText: onText), PipeReader(err, onText: onText)]
        process.terminationHandler = { p in
            DispatchQueue.main.async { onExit?(p.terminationStatus) }
        }
        do { try process.run() } catch {
            DispatchQueue.main.async { onText("⚠️ 无法启动 orch: \(error.localizedDescription)\n") }
            return nil
        }
    }

    func interrupt() { if process.isRunning { process.interrupt() } }
    func terminate() { if process.isRunning { process.terminate() } }
}
