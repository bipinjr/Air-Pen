# Air Pen ✍️

Write in the air with your index finger. A webcam follows your fingertip, the browser draws the ink, and a projector can put it on the wall, right under your finger.

Built on [MediaPipe Hands](https://developers.google.com/mediapipe/solutions/vision/hand_landmarker). No install and no build step: it's a static web page.

![Setup: webcam tracks your finger, the browser draws, the projector shows it on the wall](assets/setup.jpg)

## Run it

```bash
git clone https://github.com/bipinjr/Air-Pen.git
cd Air-Pen
python -m http.server 8000
```

Open <http://localhost:8000> in Chrome or Edge and allow the camera. Use `?theme=light` for a white board or `?theme=dark` for black. It needs internet the first time, to download the hand model.

To deploy, host the folder on any static host (GitHub Pages, Netlify, Vercel). The camera only works over **https** or on `localhost`.

## How to write

| Move | What it does |
| --- | --- |
| `Shift`, or `Page Down` / `Page Up` on a presentation clicker | Turn writing on / off |
| ☝ Only your index finger up | Write. The pen follows your index fingertip. |
| ✌ Index and middle finger up (or open hand) | Lift the pen to move between letters |

The badge in the top-left corner always shows what the camera thinks your hand is doing. The camera preview (top-right) draws your tracked hand live; the big dot is the pen point.

You don't need to reach the edges of the camera view: its comfortable middle covers the whole screen.

## Tidy words

When you finish a word, Air Pen reads your handwriting and replaces it with clean text in the same place and size, about 0.7 s after you lift the pen. Reading starts in the background the moment the pen lifts, so the swap is instant. If a slow word gets split in two, pause less between its letters (or press `Z` and rewrite it).

- `Z` turns the word back into your handwriting (and keeps it that way). `Z` again removes strokes as usual.
- `Enter` reads the word straight away. `R` (or the **Aa** button) turns tidying on or off.
- It uses Google's handwriting recognition, so it needs internet and your strokes are sent to Google. Offline, your handwriting simply stays.

## Pen mode (write with a real pen)

Press `P` (or the pen button) and hold **any pen**. The hand tracker finds your grip, and the app follows the pen body out from your fingers to its tip, which becomes the pen point.

- **Writing and lifting work like finger mode:** `Shift` or the clicker turns writing on, and raising your middle finger lifts the pen.
- **Best results:** point the pen tip away from your hand, and use a pen that stands out from what's behind it (a dark pen in front of a white board is ideal).
- **Pen pointing at the camera?** Then the camera can't see the pen body, and its tip is right at your grip, so the point sits between your thumb and index fingertip. The badge and the live view (`V`) show which one is used.

## Writing on a projector

1. Point the webcam at the projected screen, so it sees the whole picture.
2. Press `K` (or the calibrate button). A ring appears in each corner, one at a time.
3. Touch each ring on the wall with your index fingertip (or the pen tip in pen mode) and hold still for about a second.

The ink now lands right under your finger, even with the camera at an angle or a keystoned projector. The calibration is remembered. Press `K` to redo it, or `Esc` to remove it and go back to the mirror view.

## Keys

| Key | Action |
| --- | --- |
| `Z` / `Ctrl+Z` | Undo the last stroke |
| `Space` | Clear the board |
| `C` or `1`–`5` | Ink colour |
| `[` / `]` | Pen size |
| `-` / `=` | Steadiness 1–5 (higher is steadier, but the pen trails a little more) |
| `S` | Save the board as a PNG |
| `T` | White / black board |
| `K` | Calibrate to the projector (`Esc` cancels, or removes the calibration) |
| `F` | Fullscreen |
| `H` | Hide everything except the ink, for a clean board |
| `D` | Diagnostics: hand-model speed, lost-hand count, line breaks by cause |
| `V` | Big live camera view with your tracked hand drawn on it |
| `P` | Pen mode on / off (follow the tip of any pen you hold) |
| `R` | Tidy words on / off (finished words become clean text) |
| `Enter` | Tidy the current word now |

## Steady writing

- **Stabilizer:** while writing, the pen trails your fingertip on a short invisible string, so small shakes never move it.
- **Adaptive smoothing:** steady when you move slowly, quick when you move fast.
- **No broken letters:** only a clear second finger lifts the pen, and the line survives the hand vanishing for up to 0.6 s.
- **No hooks:** letters start and end exactly at your fingertip.
- **Glitch filter:** one-off tracking jumps across the screen are ignored.
- **Keeps running on a second screen:** a watchdog keeps tracking going even if the browser stops repainting a fullscreen window on the projector.

## Expo checklist

1. Laptop on charger. Close Zoom, Teams and the Camera app so the webcam is free.
2. `Win + P` → **Extend**, and drag the browser to the projector.
3. Open <http://localhost:8000/?theme=light>, wait for the badge to say "Writing is off", then press `F`.
4. Calibrate with `K` (see above), then `H` for a clean board.
5. `Shift` or the clicker to start, write, and `Shift` again to stop.

Tracking works best with light on your hand, a plain background, and the hand 0.5–2 m from the webcam. If lines break, press `D`: "broken by lost hand" means camera conditions, and a hand-model speed under ~15 fps means the laptop is too slow.

## Testing without a camera

- **Mouse mode:** with no camera, the mouse is the pen. Hold the button to draw.
- **Test file:** `?src=<image or video URL>` runs tracking on that file instead of the webcam, for example <http://localhost:8000/?src=https://storage.googleapis.com/mediapipe-assets/pointing_up.jpg>
