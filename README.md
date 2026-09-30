# Roomio

See what each part of your room hears. You outline the areas of your auditorium on its floor plan — *Front Left, Centre, Balcony, Under balcony*, whatever you want to compare — and Roomio colours each area by level: overall SPL, low-end impact, low-mids, high frequencies, or how far it is from what you hear at FOH. You measure each area once; after that every area follows the live reading from **Smaart** at the mix position.

- One map per measurement, switched from the dropdown at the top
- Each area's frequency response against FOH, plus the room average
- Areas track the live FOH level *and* the live FOH spectrum
- Works offline; everything stays on your computer

---

## 1. Install

### macOS (Apple silicon and Intel)

1. Download **`Roomio-<version>-mac-universal.dmg`** from the [Releases page](https://github.com/AndrewWilbanks/Roomio-Audio-Map/releases/latest).
2. Open the `.dmg` and drag **Roomio** into **Applications**.
3. Open it from Applications.
   *If macOS says "Roomio" Not Opened / Apple could not verify it:* click **Done**, open **System Settings → Privacy & Security**, scroll to **Security** and click **Open Anyway** next to "Roomio was blocked", then **Open Anyway** again and enter your Mac password. You only need to do this once. (On macOS 14 and earlier, right-click the app → **Open** → **Open** also works. Builds that are signed and notarized open normally.)

### Windows 10 / 11

1. Download **`Roomio-<version>-win-setup.exe`** from the [Releases page](https://github.com/AndrewWilbanks/Roomio-Audio-Map/releases/latest).
2. Run it and follow the installer. It installs for your user account only — no administrator rights needed — and adds a Start-menu and desktop shortcut.
   *If Windows SmartScreen appears:* **More info** → **Run anyway**.

### Updates

The app checks for new versions on launch and every few hours, downloads them in the background, and asks to restart when one is ready (or installs it the next time you quit). You can check any time: **Roomio → Check for Updates…** (macOS) or **Help → Check for Updates…** (Windows).

---

## 2. Turn on Smaart's API

Roomio reads Smaart through Smaart's built-in API (Smaart v9, or Smaart 8.3+ / Di 2).

1. In Smaart: **Options → Preferences → API**.
2. Turn the API **on**. The default port is **26000** — leave it unless you have a reason to change it.
3. *(Optional)* Set an API password. If you do, enter the same password in Roomio.
4. Leave Smaart running.

**Same computer or different?**

| Roomio runs on… | Smaart host to enter |
|---|---|
| the Smaart computer | `localhost` |
| another computer on the same network | the Smaart computer's IP address (e.g. `192.168.1.50`) — and allow port 26000 through that computer's firewall |

---

## 3. First run: set up your venue

The first time you open the app (or after **Reset Venue**) a four-step setup appears.

**Just looking?** Press **Try the demo** on the first step: a sample hall with pre-measured areas and simulated Smaart data, so you can see everything working without Smaart. It never touches your own venue — leave it with **Exit demo**.

1. **Auditorium** — drop in a **floor plan** of the room (PDF, PNG, JPEG or SVG) and outline its areas — see [Start from a floor plan](#start-from-a-floor-plan). Or use an auditorium file (`.json`), or a seat list (`.csv`, or an older seat-by-seat `.json`) — each section becomes an area, and big sections are split into blocks of up to 40 seats. The app checks the file and either shows a summary or lists exactly what to fix, with line numbers. No file yet? Try **Use the example hall**, or **Import a venue profile…** if you exported one from another computer. See [the file format](#5-the-auditorium-file) below.
2. **FOH position** — click the map where your FOH measurement mic is, or type its x / y (and optional height) in your file's units. If your file has no stage, you can place it here too.
3. **Smaart** — host, port, Smaart version, and the API password if you set one. Press **Test connection**; you'll get a plain answer such as *"Connected and logged in to Smaart"* or *"Nothing is listening at localhost:26000 — start Smaart and enable its API."* You can skip this and connect later.
4. **Save** — the venue opens.

---

### Start from a floor plan

Any top-down plan works: an architect's PDF or CAD export, a seating chart, a scan or a photo of a printed plan (taken straight on). Multi-page PDFs have a page picker. Everything runs on your computer; the plan isn't sent anywhere.

1. **Draw area** — click each corner of an area on the plan. Click the first corner again (or double-click, or press **Enter**) to finish it, then type its name. **Backspace** undoes the last corner. Drag to pan and scroll to zoom at any time. Draw the areas in the order you'll walk the room — that's the walk-through order (**↑** moves an area earlier).
2. Fix things in the **Areas** list beside the plan: rename, **✎** redraw an outline, **✕** remove.
3. **Stage** — click the centre front of the stage (it's shown on the map for orientation).
4. **Measure** *(optional)* — click two points a known distance apart (a wall, the stage edge) and type the distance in feet or metres. Without it, sizes are in drawing units — everything still works.
5. **Use these areas** — the plan, cropped to your areas, becomes the map's background.

How big should an area be? Small enough that one reading is fair for everyone in it — a block of seats that sits at the same distance and angle to the PA. Typical rooms end up with 6–20 areas.

---

## 4. Using it

### The status pill

Top right, always visible:

| Pill | Meaning |
|---|---|
| **Smaart live** (green) | Connected; FOH values are live |
| **Connecting / Retry in 5s** (amber) | Smaart isn't answering; the app retries automatically (1 s, 2 s, 4 s … up to every 15 s). Hover for the reason |
| **Smaart password** / **Smaart error** (red) | Smaart wants a password, or rejected it. Click the pill to fix it — the app won't keep retrying a wrong password |
| **Manual booth** | No live Smaart; FOH values you typed are being used |

Click the pill for the **Smaart** dialog: connection, **Test**, **Retry now**, and Smaart sources.

### Smaart v9 is built in

Roomio speaks the Smaart v9 API directly, so there's nothing to map. In Smaart:

1. **Options → Preferences → API** — enable the API (port 26000). If you set an API password there, enter the same one in Roomio.
2. **Calibrate** the FOH measurement mic's input — its SPL meter drives the SPL page (default metric *SPL A Slow*; change it under **SPL metric**).
3. Start a **spectrum (RTA) measurement** on the FOH mic — it drives the FOH frequency response and the Low / Lo-Mid / HF levels.

With one mic, that's it: FOH uses the first calibrated input and the first running spectrum measurement. With more, pick them in **Smaart → Smaart sources**, and choose a **Roaming mic** input and measurement to use **Capture from Smaart** in each area. **Test** lists what Smaart is offering. Your choices are part of the venue, so they move with venue profiles.

Smaart Suite does all of the above; Smaart RT/LE have spectrum but no SPL metering, and Smaart SPL has SPL but no spectrum (type or import the missing parts).

**Custom field mapping (advanced)** — for other Smaart versions or unusual setups, switch **Data source** to *Custom*: every number Smaart sends is listed under **Live messages** with its path; assign them to **Booth · SPL**, **Roaming mic · SPL**, etc., and paste any commands Smaart needs into **Poll messages**.

### Measure the room

1. Pick an area (or **Start walk-through** in Room summary).
2. Put the roaming measurement mic at seated ear height at a typical seat in that area and press **Capture response** — this saves the area's frequency response against FOH and its Low / Lo-Mid / HF levels in one go. Or type the area and booth readings and **Save readings**.
3. The app jumps to the next area. **Next unmeasured ›** skips to the next area that's missing data; the progress bar counts toward every area.

Each area keeps its readings and response; the map then shows *live FOH + that area's difference*, adjusted for how the program's spectrum has changed since you measured. **Fill gaps** estimates unmeasured areas from their measured neighbours.

### Edit areas

**Edit areas** in the top bar: **Draw area** to add one (click its corners as in setup), or click an area to rename it, move it earlier or later in the walk-through, **Redraw outline**, or remove it. Renaming and redrawing keep its measurements.

### Data

**Data** exports and imports readings as CSV. Everything is saved automatically.

---

## 5. The auditorium file

Setup writes this for you from a floor plan; you only need it to make or edit a room by hand. Any consistent unit works (feet, metres, drawing units).

### JSON (`*.auditorium.json`)

```json
{
  "format": "roomio-auditorium",
  "schemaVersion": 2,
  "name": "Main Auditorium",
  "units": "ft",
  "yAxis": "down",
  "stage": { "x": 0, "y": 0, "label": "Stage" },
  "foh":   { "x": 0, "y": 62 },
  "areas": [
    { "id": "front-left", "name": "Front Left", "points": [[-40, 12], [-10, 12], [-10, 35], [-46, 35]] },
    { "id": "centre", "name": "Centre", "points": [[-8, 12], [8, 12], [8, 35], [-8, 35]] },
    { "id": "balcony", "name": "Balcony", "points": [[-40, 60], [40, 60], [40, 75], [-40, 75]], "z": 12 }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `name` | **yes** | Room name shown in the app |
| `areas[]` | **yes** | 1 – 500 areas, in walk-through order |
| `areas[].id` | **yes** | Unique label, e.g. `"front-left"`. Readings are stored against it — keep it stable |
| `areas[].name` | no | Shown on the map (default: the id) |
| `areas[].points` | **yes** | The outline: 3 or more corners as `[x, y]` |
| `areas[].z` | no | Height (balcony, rake) |
| `units` | no | `px` (default), `ft`, `in`, `m`, `cm`, `mm` |
| `yAxis` | no | `down` (default — screen/SVG style) or `up` (CAD style) |
| `stage` | no | Centre front of the stage |
| `foh` | no | Suggested FOH position (you can move it in setup) |
| `background` | no | A floor-plan image under the areas: `{ "image": "data:image/png;base64,…", "x", "y", "width", "height", "opacity" }` (SVG, PNG, JPEG or WebP, up to 25 MB) |

The complete JSON Schema is in [`docs/auditorium.schema.json`](docs/auditorium.schema.json); an example is in [`docs/examples/`](docs/examples/).

### Seat lists (older files and CSV)

A list of individual seats still works — each **section** becomes an area outlined around its seats; sections with more than 40 seats are split into blocks of up to 40 (named *C 1, C 2…* from the stage back). Rename, redraw or merge them afterwards with **Edit areas**. That covers version-1 files (`"schemaVersion": 1` with `"seats": [{ "id", "x", "y", "section" }]`) and CSV:

```csv
seat,x,y,z
A-1-1,-12.5,20,0
A-1-2,-10.5,20,0
B-2-7,4,24.5,0.3
```

- The header line is optional; `z` can be empty. Add a `section` column, or use labels like `A-12-4` (section **A**).
- Commas, semicolons or tabs all work. Lines starting with `#` are ignored.
- In setup you choose the venue name, units, and whether Y goes up (CAD — the default for CSV) or down.

---

## 6. Venues, profiles and your data

Everything lives in your user folder:

- macOS: `~/Library/Application Support/Roomio/`
- Windows: `%APPDATA%\Roomio\`

| File | What's in it |
|---|---|
| `venue.json` | The auditorium and its areas, FOH position, Smaart settings (`schemaVersion` 2). Venues from Roomio 0.1.x (seat by seat) are converted to areas (up to 40 seats each) the first time they open — the originals are kept in `backups/` |
| `measurements.json` | Area readings and frequency responses |
| `credentials.json` | The Smaart API password, encrypted with your system keychain |
| `backups/` | Venues replaced by New Venue, Reset or Import, and the originals of converted 0.1.x venues |

**Settings** (⌘, / Ctrl+,) and the **Venue** (macOS) / **File** (Windows) menu:

- **Export Venue Profile…** — one `.roomio.json` file with the venue, its Smaart setup and (optionally) its measurements. Use it to move to another computer or keep a backup. The Smaart password is never included.
- **Import Venue Profile…** — replaces the current venue (the current one goes to `backups/`).
- **New Venue…** — run setup again for another room; the current venue goes to `backups/`.
- **Reset Venue…** — clear this venue and start setup again (also backed up first).
- **Back Up All Data…** — saves the venue and every measurement in one file, wherever you choose.

---

## 7. Troubleshooting

| Problem | Try |
|---|---|
| *"Nothing is listening at localhost:26000"* | Smaart isn't running, or its API is off (Options → Preferences → API) |
| *"Smaart answered, but not at /api/v4/"* | Pick your Smaart version in the Smaart dialog (v9 = `/api/v4/`, Smaart 8 / Di 2 = `/api/v3/`) |
| *"Smaart needs its API password"* / *"rejected the API password"* | Enter the same password as in Smaart's API preferences, then **Connect** |
| Connected, but values show — | Smaart has nothing to stream: calibrate the FOH input and start a spectrum measurement. The Smaart dialog's **Streaming now** shows what Roomio is receiving |
| Works on the Smaart computer but not from another one | Use the Smaart computer's IP as host, and allow port 26000 in its firewall |
| The auditorium file won't load | Setup lists each problem with its line, area or seat number — fix those and choose the file again |
| An area finished too early | Corners snap closed when you click near the first one — zoom in for small areas, or **✎** redraw it |

---

## For developers

```bash
npm install
npm start                 # run from source
npm test                  # unit tests (parser, venue store, Smaart service)
npm run e2e               # drives the real app (needs python3 for dev/mock_smaart.py)
npm run dist:mac          # dist/Roomio-<v>-mac-universal.dmg + .zip
npm run dist:win          # dist/Roomio-<v>-win-setup.exe
```

`RA_USER_DATA=<folder> npm start` runs against a separate data folder (dev / direct builds only).
**Read [`SANDBOX.md`](SANDBOX.md) before changing anything** — Roomio must stay buildable for the Mac App Store and Microsoft Store.
After editing this README, run `node dev/build-help.js` (it becomes the in-app Help). Releases are built and published to GitHub Releases by `.github/workflows/release.yml` when a `v*` tag is pushed — see `docs/RELEASING.md`.
