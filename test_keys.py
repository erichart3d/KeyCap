"""
Diagnostic script — prints every key event the `keyboard` library reports,
along with the modifier state it detects for that moment. Run this, press
a few keys, and you'll see exactly what names come through.

Usage:
    python test_keys.py

Press Ctrl+Q to quit.
"""
import time
import keyboard


def on_press(event):
    name = (event.name or '').lower()
    mods = []
    if keyboard.is_pressed('ctrl'):
        mods.append('CTRL')
    if keyboard.is_pressed('shift'):
        mods.append('SHIFT')
    if keyboard.is_pressed('alt'):
        mods.append('ALT')
    if keyboard.is_pressed('windows'):
        mods.append('WIN')
    print(f"  PRESS   name={name!r:<16}  scan_code={event.scan_code:<4}  mods={mods}")


def on_release(event):
    name = (event.name or '').lower()
    print(f"  RELEASE name={name!r}")


def main():
    print("=" * 60)
    print("  Key diagnostic — press keys to see raw events")
    print("  Press Ctrl+Q to quit")
    print("=" * 60)
    keyboard.on_press(on_press)
    keyboard.on_release(on_release)
    try:
        keyboard.wait('ctrl+q')
    except KeyboardInterrupt:
        pass
    print("\nDone.")


if __name__ == '__main__':
    main()
