import SwiftUI
import UIKit

/// The iPhone Duo lab's app (scripts/duo-lab.sh): it shows its posture and every hinge update, has a button in each
/// region of whichever screen it is on and one right beside the fold, and writes what happened to
/// Documents/duo-lab.json, so the lab proves where each tap, key and swipe landed from the app itself, not from a
/// read of the screen. Its UIHingeInteraction use follows AXe 2.0's playground (MIT).
@main
struct DuoLabApp: App {
    var body: some Scene {
        WindowGroup { LabView().ignoresSafeArea() }
    }
}

struct LabView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> LabController { LabController() }
    func updateUIViewController(_ controller: LabController, context: Context) {}
}

/// One touch the app took: which control, where in the window, on a window of what size.
struct Touch: Codable {
    let id: String
    let x: Double
    let y: Double
    let inside: Bool
    let window: [Double]
    let mode: String
    let at: Double
}

struct LabLog: Codable {
    var launched = Date().timeIntervalSince1970
    var mode = "single"
    var hingeStatus = "unknown"
    var hingeDegrees: Double? = nil
    var hingeUpdates = 0
    var window: [Double] = []
    var division: [Double]? = nil
    var touches: [Touch] = []
    var text = ""
    var keysTyped = 0
    var scrollY = 0.0
    var held = 0
    var swipes: [String] = []
    var page = "grid"
}

final class LabController: UIViewController, UITextFieldDelegate, UIScrollViewDelegate {
    private var log = LabLog()
    private let status = UILabel()
    private let last = UILabel()
    private let page = UISegmentedControl(items: ["Grid", "Tools"])
    private var cells: [UIButton] = []
    private let nearFold = UIButton(type: .system)
    private let field = UITextField()
    private let echo = UILabel()
    private let list = UIScrollView()
    private let hold = UIButton(type: .system)
    private let swipeArea = UILabel()
    private var division: CGRect?
    private static let rows = ["A", "B", "C"], columns = ["1", "2"]

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        status.numberOfLines = 2
        status.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        status.accessibilityIdentifier = "posture"
        last.font = .systemFont(ofSize: 15, weight: .semibold)
        last.accessibilityIdentifier = "last"
        last.text = "Last: none"
        page.selectedSegmentIndex = 0
        page.accessibilityIdentifier = "page"
        page.addTarget(self, action: #selector(pageChanged), for: .valueChanged)
        for v in [status, last, page] as [UIView] { view.addSubview(v) }
        for row in Self.rows {
            for column in Self.columns {
                let b = UIButton(type: .system)
                b.setTitle("Cell \(row)\(column)", for: .normal)
                b.titleLabel?.font = .systemFont(ofSize: 20, weight: .medium)
                b.backgroundColor = .secondarySystemFill
                b.layer.cornerRadius = 10
                b.accessibilityIdentifier = "cell-\(row)\(column)"
                b.addTarget(self, action: #selector(tapped(_:event:)), for: .touchUpInside)
                cells.append(b); view.addSubview(b)
            }
        }
        nearFold.setTitle("Near fold", for: .normal)
        nearFold.backgroundColor = .systemYellow.withAlphaComponent(0.4)
        nearFold.layer.cornerRadius = 8
        nearFold.accessibilityIdentifier = "nearFold"
        nearFold.addTarget(self, action: #selector(tapped(_:event:)), for: .touchUpInside)
        view.addSubview(nearFold)
        field.placeholder = "Note"
        field.accessibilityLabel = "Note"
        field.accessibilityIdentifier = "note"
        field.borderStyle = .roundedRect
        field.autocorrectionType = .no
        field.autocapitalizationType = .none
        field.spellCheckingType = .no
        field.delegate = self
        field.addTarget(self, action: #selector(textChanged), for: .editingChanged)
        echo.accessibilityIdentifier = "echo"
        echo.text = "Echo: "
        list.delegate = self
        list.accessibilityIdentifier = "list"
        list.backgroundColor = .secondarySystemBackground
        for row in 1...40 {
            let label = UILabel()
            label.text = "Row \(row)"
            label.tag = row
            list.addSubview(label)
        }
        hold.setTitle("Hold me", for: .normal)
        hold.backgroundColor = .tertiarySystemFill
        hold.accessibilityIdentifier = "hold"
        hold.addGestureRecognizer(UILongPressGestureRecognizer(target: self, action: #selector(held(_:))))
        swipeArea.text = "Swipe here"
        swipeArea.textAlignment = .center
        swipeArea.backgroundColor = .quaternarySystemFill
        swipeArea.isUserInteractionEnabled = true
        swipeArea.accessibilityIdentifier = "swipeArea"
        for direction in [UISwipeGestureRecognizer.Direction.left, .right] {
            let swipe = UISwipeGestureRecognizer(target: self, action: #selector(swiped(_:)))
            swipe.direction = direction
            swipeArea.addGestureRecognizer(swipe)
        }
        for v in [field, echo, list, hold, swipeArea] as [UIView] { view.addSubview(v) }
        if #available(iOS 27.1, *) {
            let interaction = UIHingeInteraction { [weak self] _, update in
                guard let self else { return }
                self.log.hingeUpdates += 1
                guard let hinge = update.hinge else { self.log.hingeStatus = "none"; self.publish(); return }
                self.log.hingeStatus = "\(hinge.status)"
                self.log.hingeDegrees = (Double(hinge.angle) * 180 / .pi * 10).rounded() / 10
                self.view.setNeedsLayout()
                self.publish()
            }
            view.addInteraction(interaction)
        }
        pageChanged()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let usable = view.bounds.inset(by: view.safeAreaInsets).insetBy(dx: 12, dy: 8)
        // The fold, where the guest reserves it (a half-open Duo's inner screen).
        division = nil
        log.mode = "single"
        if #available(iOS 27.1, *) {
            let active = view.reservedRegions(kind: .division, options: .includeInactive).filter(\.isActive)
            if active.count == 1, let frame = active.first?.frame, usable.intersects(frame) {
                division = frame
                log.mode = frame.height > frame.width ? "split-vertical" : "split-horizontal"
            }
        }
        log.division = division.map { [$0.minX, $0.minY, $0.width, $0.height] }
        log.window = [view.bounds.width, view.bounds.height]
        status.frame = CGRect(x: usable.minX, y: usable.minY, width: usable.width, height: 40)
        last.frame = CGRect(x: usable.minX, y: usable.minY + 42, width: usable.width / 2, height: 30)
        page.frame = CGRect(x: usable.midX, y: usable.minY + 42, width: usable.width / 2, height: 30)
        let body = CGRect(x: usable.minX, y: usable.minY + 80, width: usable.width, height: usable.height - 80)
        // The grid: rows A to C, columns 1 and 2, kept off the fold: split across it when there is one.
        var first = body, second = CGRect.null
        if let d = division, log.mode == "split-vertical" {
            first = CGRect(x: body.minX, y: body.minY, width: d.minX - body.minX - 8, height: body.height)
            second = CGRect(x: d.maxX + 8, y: body.minY, width: body.maxX - d.maxX - 8, height: body.height)
        } else if let d = division, log.mode == "split-horizontal" {
            first = CGRect(x: body.minX, y: body.minY, width: body.width, height: d.minY - body.minY - 8)
            second = CGRect(x: body.minX, y: d.maxY + 8, width: body.width, height: body.maxY - d.maxY - 8)
        }
        for (i, b) in cells.enumerated() {
            let row = i / 2, column = i % 2
            var area = first, rowsHere = 3, rowIndex = row
            if !second.isNull {
                if log.mode == "split-vertical" { area = column == 0 ? first : second }
                else { area = row < 2 ? first : second; rowsHere = row < 2 ? 2 : 1; rowIndex = row < 2 ? row : 0 }
            }
            let columnsHere = (!second.isNull && log.mode == "split-vertical") ? 1 : 2
            let w = area.width / CGFloat(columnsHere), h = min(area.height / CGFloat(rowsHere), 120)
            let x = area.minX + (columnsHere == 1 ? 0 : CGFloat(column) * w)
            b.frame = CGRect(x: x + 4, y: area.minY + CGFloat(rowIndex) * h + 4, width: w - 8, height: h - 8)
        }
        // Beside the fold (just before it), or in the middle of the screen when there is none.
        if let d = division {
            nearFold.frame = log.mode == "split-vertical" ? CGRect(x: d.minX - 70, y: body.maxY - 60, width: 66, height: 44)
                : CGRect(x: body.midX - 60, y: d.minY - 48, width: 120, height: 44)
        } else {
            nearFold.frame = CGRect(x: body.midX - 60, y: body.maxY - 50, width: 120, height: 44)
        }
        field.frame = CGRect(x: body.minX, y: body.minY, width: body.width, height: 40)
        echo.frame = CGRect(x: body.minX, y: body.minY + 44, width: body.width, height: 28)
        hold.frame = CGRect(x: body.minX, y: body.minY + 76, width: body.width / 2 - 4, height: 44)
        swipeArea.frame = CGRect(x: body.midX + 4, y: body.minY + 76, width: body.width / 2 - 4, height: 44)
        list.frame = CGRect(x: body.minX, y: body.minY + 128, width: body.width, height: max(80, body.height - 128))
        for row in 1...40 { list.viewWithTag(row)?.frame = CGRect(x: 12, y: CGFloat(row - 1) * 44, width: list.bounds.width - 24, height: 44) }
        list.contentSize = CGSize(width: list.bounds.width, height: 40 * 44)
        publish()
    }

    @objc private func pageChanged() {
        let grid = page.selectedSegmentIndex == 0
        log.page = grid ? "grid" : "tools"
        for b in cells { b.isHidden = !grid }
        nearFold.isHidden = !grid
        for v in [field, echo, list, hold, swipeArea] as [UIView] { v.isHidden = grid }
        if grid { field.resignFirstResponder() }
        publish()
    }

    @objc private func tapped(_ sender: UIButton, event: UIEvent) {
        let id = sender.accessibilityIdentifier ?? "?"
        let point = event.allTouches?.first?.location(in: view) ?? CGPoint(x: -1, y: -1)
        log.touches.append(Touch(id: id, x: Double(point.x), y: Double(point.y), inside: sender.frame.contains(point),
                                 window: log.window, mode: log.mode, at: Date().timeIntervalSince1970))
        last.text = "Last: \(id)"
        publish()
    }

    @objc private func textChanged() { log.text = field.text ?? ""; log.keysTyped += 1; echo.text = "Echo: \(log.text)"; publish() }
    func textFieldShouldReturn(_ textField: UITextField) -> Bool { textField.resignFirstResponder(); return true }
    func scrollViewDidScroll(_ scrollView: UIScrollView) { log.scrollY = Double(scrollView.contentOffset.y); publish() }
    @objc private func held(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began else { return }
        log.held += 1; last.text = "Held: \(log.held)"; publish()
    }
    @objc private func swiped(_ gesture: UISwipeGestureRecognizer) {
        log.swipes.append(gesture.direction == .left ? "left" : "right")
        last.text = "Swiped \(log.swipes.last!) (\(log.swipes.count))"
        publish()
    }

    private func publish() {
        status.text = "\(log.mode) · hinge \(log.hingeStatus) \(log.hingeDegrees.map { "\($0)°" } ?? "") · updates \(log.hingeUpdates)\n\(Int(view.bounds.width))x\(Int(view.bounds.height))"
        status.accessibilityValue = log.mode
        if let data = try? JSONEncoder().encode(log) {
            try? data.write(to: URL.documentsDirectory.appending(path: "duo-lab.json"), options: .atomic)
        }
    }
}
