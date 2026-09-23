import Cocoa

// Application-only timing beacon. Every drawn binary strip encodes the guest UTC
// milliseconds, permitting a mapping from the first actual decoded video frame.
let root = CommandLine.arguments[1]
let app = NSApplication.shared
app.setActivationPolicy(.regular)
// Real AppKit responder-chain menu action. Command-W is not synthetic hiding.
let mainMenu = NSMenu()
let appItem = NSMenuItem()
let appMenu = NSMenu(title:"RelayClock")
appMenu.addItem(withTitle:"Quit RelayClock", action:#selector(NSApplication.terminate(_:)), keyEquivalent:"q")
appItem.submenu = appMenu; mainMenu.addItem(appItem)
let windowItem = NSMenuItem(title:"Window",action:nil,keyEquivalent:"")
let windowMenu = NSMenu(title:"Window")
windowMenu.addItem(withTitle:"Close",action:#selector(NSWindow.performClose(_:)),keyEquivalent:"w")
windowItem.submenu = windowMenu; mainMenu.addItem(windowItem)
app.mainMenu = mainMenu; app.windowsMenu = windowMenu
let logURL = URL(fileURLWithPath: root + "/clock.jsonl")
FileManager.default.createFile(atPath: logURL.path, contents: nil)
let log = try! FileHandle(forWritingTo: logURL)
class ClockView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.setFill(); bounds.fill()
        let ms = UInt64(Date().timeIntervalSince1970 * 1000)
        // Strip x=16..975, y=8..27 in logical screen bottom coordinates.
        for i in 0..<48 {
            (((ms >> (47-i)) & 1) == 1 ? NSColor.white : NSColor.black).setFill()
            NSRect(x:16+i*20,y:8,width:20,height:20).fill()
        }
        let text = "UTC milliseconds \(ms) — binary clock maps first video frame; not recorder launch"
        (text as NSString).draw(at:NSPoint(x:16,y:40),withAttributes:[.font:NSFont.monospacedSystemFont(ofSize:16,weight:.medium),.foregroundColor:NSColor.white])
        try! log.write(contentsOf: Data(("{\"utcMs\":\(ms)}\n").utf8))
    }
}
let panel = NSPanel(contentRect:NSRect(x:0,y:0,width:1024,height:80),styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
panel.level = .screenSaver
panel.isOpaque = true
panel.backgroundColor = .black
panel.ignoresMouseEvents = true
panel.collectionBehavior = [.canJoinAllSpaces,.fullScreenAuxiliary]
let view = ClockView(frame:panel.contentView!.bounds)
panel.contentView = view
panel.orderFrontRegardless()
let win = NSWindow(contentRect:NSRect(x:150,y:300,width:900,height:400),styleMask:[.titled,.closable],backing:.buffered,defer:false)
win.title = "Relay macOS ordinary keyboard acceptance"
win.level = .floating
let label = NSTextField(labelWithString:"Native field: click and type relay using real CGEvent keys")
label.font = .systemFont(ofSize:24); label.frame = NSRect(x:30,y:300,width:840,height:40)
let field = NSTextField(frame:NSRect(x:30,y:210,width:780,height:55)); field.font = .monospacedSystemFont(ofSize:28,weight:.regular)
win.contentView!.addSubview(label); win.contentView!.addSubview(field)
win.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps:true)
let screen = NSScreen.main!
let center = win.convertPoint(toScreen:NSPoint(x:400,y:235))
let facts:[String:Any] = ["pid":ProcessInfo.processInfo.processIdentifier,"windowId":win.windowNumber,"localX":400*screen.backingScaleFactor,"localY":(win.frame.height-235)*screen.backingScaleFactor,"width":screen.frame.width,"height":screen.frame.height,"scale":screen.backingScaleFactor,"fieldX":center.x*screen.backingScaleFactor,"fieldY":(screen.frame.height-center.y)*screen.backingScaleFactor]
try! JSONSerialization.data(withJSONObject:facts,options:.prettyPrinted).write(to:URL(fileURLWithPath:root+"/clock-geometry.json"))
Timer.scheduledTimer(withTimeInterval:0.02,repeats:true) { _ in view.needsDisplay = true
    try! field.stringValue.data(using:.utf8)!.write(to:URL(fileURLWithPath:root+"/native-text.txt"),options:.atomic)
    try! JSONSerialization.data(withJSONObject:["utcMs":UInt64(Date().timeIntervalSince1970*1000),"windowVisible":win.isVisible,"windowId":win.windowNumber]).write(to:URL(fileURLWithPath:root+"/native-window.json"),options:.atomic)
}
app.run()
