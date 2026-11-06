// Runs the official packs through Blockwork's real parser and interpreter.
// Not part of `npm test`: `npm run test:runtime -- <Blockwork target/debug/deps>`
// (scripts/test-pack-runtime.py) compiles and runs it.
extern crate blockwork_core;
use blockwork_core::{
    block_packs::{merge_into, read_pack},
    input::{
        types::{Axis, Direction, MacroButton, MacroKey},
        value::{Evaluated, ExtOperator, Op, Value, register_operators},
    },
    macros::{BlockKind, Instruction, InstructionKind as K, Macro, backend::InputBackend},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
static CLIP: Mutex<String> = Mutex::new(String::new());
static EVENTS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static WINDOWS: Mutex<Vec<(String, [f64; 4])>> = Mutex::new(Vec::new());
fn number(args: &[Evaluated], i: usize) -> f64 {
    args[i].as_number().unwrap()
}
static FIXTURES: &[ExtOperator] = &[
    ExtOperator {
        kind: "ClipboardText",
        op: "ClipboardText",
        arity: 0,
        default_args: Vec::new,
        eval: |_| Ok(Evaluated::Text(CLIP.lock().unwrap().clone())),
    },
    ExtOperator {
        kind: "MonitorCount",
        op: "MonitorCount",
        arity: 0,
        default_args: Vec::new,
        eval: |_| Ok(Evaluated::Number(2.)),
    },
    ExtOperator {
        kind: "MonitorInfo",
        op: "MonitorInfo",
        arity: 2,
        default_args: Vec::new,
        eval: |a| {
            assert_eq!(number(a, 0), 2.);
            Ok(Evaluated::Number(match a[1].as_text().as_str() {
                "x" => -1920.,
                "y" => -100.,
                "width" => 1921.,
                "height" => 1080.,
                _ => panic!(),
            }))
        },
    },
    ExtOperator {
        kind: "WindowInfo",
        op: "WindowInfo",
        arity: 2,
        default_args: Vec::new,
        eval: |a| {
            let windows = WINDOWS.lock().unwrap();
            let (_, bounds) = windows
                .iter()
                .find(|(name, _)| *name == a[0].as_text())
                .ok_or("missing window")?;
            Ok(Evaluated::Number(
                bounds[match a[1].as_text().as_str() {
                    "x" => 0,
                    "y" => 1,
                    "width" => 2,
                    "height" => 3,
                    _ => panic!(),
                }],
            ))
        },
    },
    ExtOperator {
        kind: "RecordAction",
        op: "RecordAction",
        arity: 2,
        default_args: Vec::new,
        eval: |a| {
            EVENTS
                .lock()
                .unwrap()
                .push(format!("{} {}", a[0].as_text(), a[1].as_text()));
            Ok(Evaluated::Number(0.))
        },
    },
    ExtOperator {
        kind: "RecordPlace",
        op: "RecordPlace",
        arity: 4,
        default_args: Vec::new,
        eval: |a| {
            EVENTS.lock().unwrap().push(format!(
                "{} {} {},{}",
                a[0].as_text(),
                a[1].as_text(),
                number(a, 2).round() as i32,
                number(a, 3).round() as i32
            ));
            Ok(Evaluated::Number(0.))
        },
    },
];
struct Recorder;
impl InputBackend for Recorder {
    fn key(&mut self, _: MacroKey, _: Direction) -> Result<(), String> {
        Ok(())
    }
    fn raw_keycode(&mut self, _: u16, _: Direction) -> Result<(), String> {
        Ok(())
    }
    fn button(&mut self, _: MacroButton, d: Direction) -> Result<(), String> {
        EVENTS.lock().unwrap().push(format!("{d:?}"));
        Ok(())
    }
    fn move_mouse_rel(&mut self, _: i32, _: i32) -> Result<(), String> {
        panic!()
    }
    fn move_mouse_abs(&mut self, x: i32, y: i32) -> Result<(), String> {
        EVENTS.lock().unwrap().push(format!("move {x},{y}"));
        Ok(())
    }
    fn scroll(&mut self, _: i32, _: Axis) -> Result<(), String> {
        Ok(())
    }
    fn text(&mut self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn cursor_pos(&self) -> Option<(i32, i32)> {
        Some((0, 0))
    }
}
fn op(name: &str, args: Vec<Value>) -> Value {
    Value::op(Op::from_name(name), args)
}
// Adapt only native clipboard/window writes; leave all control flow, arithmetic,
// text operations, parameter scopes and mouse dispatch to the actual runtime.
fn adapt(body: &mut Vec<Instruction>) {
    for i in body {
        for b in 0..2 {
            if let Some(body) = i.kind.body_mut(b) {
                adapt(body);
            }
        }
        i.kind = match &i.kind {
            K::SetClipboard(v) => K::SetVariable("clipboard result".into(), v.clone()),
            K::WindowAction {
                action, pattern, ..
            } => K::SetVariable(
                "event".into(),
                op("RecordAction", vec![Value::text(action), pattern.clone()]),
            ),
            K::MoveWindow {
                pattern,
                resize,
                x,
                y,
                ..
            } => K::SetVariable(
                "event".into(),
                op(
                    "RecordPlace",
                    vec![
                        Value::text(if *resize { "resize" } else { "place" }),
                        pattern.clone(),
                        x.clone(),
                        y.clone(),
                    ],
                ),
            ),
            other => other.clone(),
        };
    }
}
fn run(pack_id: &str, identifier: &str, args: Vec<Value>) -> HashMap<String, Evaluated> {
    EVENTS.lock().unwrap().clear();
    let mut pack =
        read_pack(&std::fs::read_to_string(format!("packs/{pack_id}.json")).unwrap()).unwrap();
    let def = pack
        .content
        .block_defs
        .iter()
        .find(|d| d.identifier == format!("Blockworked:{identifier}"))
        .unwrap()
        .clone();
    let body = if format!("{:?}", def.shape) == "ReturnsValue" {
        K::SetVariable(
            "result".into(),
            Value::Call {
                block_id: def.id,
                args,
                branches: vec![],
                saved: Box::new(Value::number(0.)),
            },
        )
    } else {
        K::CallBlock {
            block_id: def.id,
            args,
            branches: vec![],
        }
    };
    for strand in &mut pack.content.graph.strands {
        adapt(&mut strand.instructions);
    }
    let mut mac = Macro::new(
        "test".into(),
        "".into(),
        vec![Instruction::new(K::TryCatch {
            body: vec![
                Instruction::new(body),
                Instruction::new(K::SetVariable("ok".into(), Value::number(1.))),
            ],
            catch_body: vec![Instruction::new(K::SetVariable(
                "error".into(),
                op("LastError", vec![]),
            ))],
        })],
    );
    merge_into(&mut mac, &pack, "");
    // Pack variables run under a private key; tests read them by their own name.
    let prefix = mac.settings.block_packs[0].variable_key("");
    let vars = Arc::new(Mutex::new(HashMap::new()));
    mac.run(Arc::new(Mutex::new(Recorder)), None, 1000000., vars.clone());
    let result = vars.lock().unwrap().clone();
    result
        .into_iter()
        .map(|(k, v)| (k.strip_prefix(&prefix).map(str::to_string).unwrap_or(k), v))
        .collect()
}
fn strings(args: &[&str]) -> Vec<Value> {
    args.iter().map(|s| Value::text(*s)).collect()
}
fn text_case(id: &str, args: &[&str], want: &str) {
    let vars = run("text-extraction", id, strings(args));
    assert_eq!(
        vars.get("result"),
        Some(&Evaluated::Text(want.into())),
        "{id} {args:?}: {vars:?}"
    );
}
fn clip_case(id: &str, input: &str, want: &str) {
    *CLIP.lock().unwrap() = input.into();
    let vars = run("clipboard-tools", id, vec![]);
    assert_eq!(
        vars.get("clipboard result"),
        Some(&Evaluated::Text(want.into())),
        "{id} {input:?}: {vars:?}"
    );
}
fn events() -> Vec<String> {
    EVENTS.lock().unwrap().clone()
}
fn main() {
    register_operators(FIXTURES);
    blockwork_core::init();
    for (args, want) in [
        (["[", "]", "before [hé🙂llo] after"], "hé🙂llo"),
        ([".*", "$", "x.*a\nb$z"], "a\nb"),
        (["[", "]", "][one][two]"], "one"),
        (["[", "]", "missing [end"], ""),
        (["", "]", "[]"], ""),
        (["[", "]", "[]"], ""),
    ] {
        text_case("TextBetweenMarkers", &args, want);
    }
    text_case(
        "TextMatchingLines",
        &["ERR", "ok\r\nERR one\rERR two\nerr three"],
        "ERR one\nERR two",
    );
    text_case("TextMatchingLines", &["", "a\r\n\r\nb\n"], "a\n\nb\n");
    text_case(
        "TextMatchingLines",
        &[".*", "abc\n.* literal"],
        ".* literal",
    );
    text_case("TextMatchingLines", &["nothing", "abc"], "");
    text_case(
        "TextKeyValue",
        &[" key ", "#key=bad\r\nkey = a=b\nkey=c"],
        "a=b",
    );
    text_case("TextKeyValue", &["01", "1=wrong\n01=right"], "right");
    text_case("TextKeyValue", &["", "=bad"], "");
    text_case("TextKeyValue", &["a", "a=\na=second"], "");
    text_case("TextKeyValue", &["absent", "a=b"], "");
    clip_case(
        "ClipboardDeduplicateLines",
        "01\n1\n01\nA\na\nA\n\n",
        "01\n1\nA\na\n",
    );
    clip_case("ClipboardDeduplicateLines", "a\r\na\ra\nb\r\nb", "a\nb");
    clip_case("ClipboardDeduplicateLines", "", "");
    clip_case(
        "ClipboardRemoveBlankLines",
        "\r\n  a  \n\t\n\u{2003}\n b\n",
        "  a  \n b",
    );
    clip_case(
        "ClipboardCleanWhitespace",
        "  a\t  b \r\n \t\n c  d\n",
        "a b\nc d",
    );
    clip_case("ClipboardCleanWhitespace", " \t\n\r\n", "");
    let vars = run(
        "mouse-patterns",
        "ClickGrid",
        strings(&["10", "20", "2", "3", "-5", "10", "0"]),
    );
    assert!(vars.contains_key("ok"), "{vars:?}");
    assert_eq!(
        events(),
        [
            "move 10,20",
            "Click",
            "move 5,20",
            "Click",
            "move 0,20",
            "Click",
            "move 10,30",
            "Click",
            "move 5,30",
            "Click",
            "move 0,30",
            "Click"
        ]
    );
    run(
        "mouse-patterns",
        "ClickGrid",
        strings(&["0", "0", "0", "3", "5", "5", "0"]),
    );
    assert!(events().is_empty());
    for args in [
        ["0", "0", "1.5", "3", "5", "5", "0"],
        ["bad", "0", "1", "3", "5", "5", "0"],
        ["0", "0", "1", "3", "5", "5", "-1"],
        ["NaN", "0", "1", "3", "5", "5", "0"],
        ["0", "0", "1", "3", "5", "5", "inf"],
    ] {
        let vars = run("mouse-patterns", "ClickGrid", strings(&args));
        assert!(vars.contains_key("error"), "{vars:?}");
        assert!(events().is_empty());
    }
    run(
        "mouse-patterns",
        "DragThroughPoints",
        strings(&[" 10,20\r\n30, 40\n-5,0 ", "0"]),
    );
    assert_eq!(
        events(),
        ["move 10,20", "Press", "move 30,40", "move -5,0", "Release"]
    );
    run(
        "mouse-patterns",
        "DragThroughPoints",
        strings(&["100,100; 200,200", "0"]),
    );
    assert_eq!(
        events(),
        ["move 100,100", "Press", "move 200,200", "Release"]
    );
    run(
        "mouse-patterns",
        "DragThroughPoints",
        strings(&["10,20; 30,40\n-5,0", "0"]),
    );
    assert_eq!(
        events(),
        ["move 10,20", "Press", "move 30,40", "move -5,0", "Release"]
    );
    for path in [
        "1,2",
        "1,2\n3,4\n5,no",
        "1,2\n3,4,5",
        "1,2\n\n3,4",
        "1,2\nNaN,4",
        "1,2\n3,inf",
        "1,2; bad,4",
        "1,2;;3,4",
    ] {
        let vars = run("mouse-patterns", "DragThroughPoints", strings(&[path, "0"]));
        assert!(vars.contains_key("error"), "{path:?}: {vars:?}");
        assert!(events().is_empty());
    }
    *WINDOWS.lock().unwrap() = vec![
        ("left".into(), [20., 30., 800., 600.]),
        ("right".into(), [850., 30., 800., 600.]),
    ];
    let vars = run(
        "window-layouts",
        "CaptureWindowGeometry",
        strings(&["left"]),
    );
    assert_eq!(
        vars.get("result"),
        Some(&Evaluated::Text(
            "{\"x\":20,\"y\":30,\"width\":800,\"height\":600}".into()
        ))
    );
    run(
        "window-layouts",
        "RestoreWindowGeometry",
        strings(&[
            "left",
            "{\"x\":-1200,\"y\":-50,\"width\":700,\"height\":500}",
        ]),
    );
    assert_eq!(
        events(),
        [
            "Restore left",
            "resize left 700,500",
            "place left -1200,-50"
        ]
    );
    for snapshot in [
        "bad",
        "{\"x\":0}",
        "{\"x\":0,\"y\":0,\"width\":-1,\"height\":50}",
        "{\"x\":0,\"y\":0,\"width\":0.1,\"height\":50}",
        "{\"x\":\"NaN\",\"y\":0,\"width\":100,\"height\":50}",
    ] {
        let vars = run(
            "window-layouts",
            "RestoreWindowGeometry",
            strings(&["left", snapshot]),
        );
        assert!(vars.contains_key("error"));
        assert!(events().is_empty());
    }
    run(
        "window-layouts",
        "CenterWindowOnMonitor",
        strings(&["left", "2"]),
    );
    assert_eq!(events(), ["Restore left", "place left -1360,140"]);
    run(
        "window-layouts",
        "TileWindowsSideBySide",
        strings(&["left", "right", "2", "20"]),
    );
    assert_eq!(
        events(),
        [
            "Restore left",
            "Restore right",
            "resize left 950,1080",
            "place left -1920,-100",
            "resize right 951,1080",
            "place right -950,-100"
        ]
    );
    for args in [
        ["left", "missing", "2", "20"],
        ["left", "right", "0", "20"],
        ["left", "right", "2", "1920"],
        ["left", "right", "2", "bad"],
    ] {
        let vars = run("window-layouts", "TileWindowsSideBySide", strings(&args));
        assert!(vars.contains_key("error"), "{vars:?}");
        assert!(events().is_empty());
    }
    run(
        "mouse-patterns",
        "ClickInWindow",
        strings(&["left", "10", "15"]),
    );
    assert_eq!(events(), ["Focus left", "move 30,45", "Click"]);
    let vars = run(
        "mouse-patterns",
        "ClickInWindow",
        strings(&["left", "800", "15"]),
    );
    assert!(vars.contains_key("error"));
    assert!(events().is_empty());
    println!(
        "All 13 official blocks passed runtime behavior and error-path checks with simulated desktop I/O."
    );
}
