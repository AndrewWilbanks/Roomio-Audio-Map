# Roomio

See what every seat in your room hears. Roomio draws your auditorium seat by seat and colours each seat by level — overall SPL, low-end impact, low-mids, high frequencies, or how far it is from what you hear at FOH. You measure each seat once; after that every seat follows the live reading from **Smaart** at the mix position.

- One map per measurement, switched from the dropdown at the top
- Each seat's frequency response against FOH, plus the room average
- Seats track the live FOH level *and* the live FOH spectrum
- Works offline; everything stays on your computer

---

## 1. Install

### macOS (Apple silicon and Intel)

1. Download **`Roomio-<version>-mac-universal.dmg`** from the [Releases page](https://github.com/AndrewWilbanks/Roomio-Audio-Map/releases/latest).
2. Open the `.dmg` and drag **Roomio** into **Applications**.
3. Open it from Applications.
   *If macOS says it "can't be opened because Apple cannot check it":* right-click the app → **Open** → **Open**. You only need to do this once. (Builds that are signed and notarized open normally.)

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

**Just looking?** Press **Try the demo** on the first step: a sample hall with pre-measured seats and simulated Smaart data, so you can see everything working without Smaart. It never touches your own venue — leave it with **Exit demo**.

1. **Auditorium** — drop in your auditorium file (`.json`) or a seat list (`.csv`). The app checks it and either shows a summary (seats, sections, size) or lists exactly what to fix, with line numbers. No file yet? Try **Use the example hall**, or **Import a venue profile…** if you exported one from another computer. See [the file format](#5-the-auditorium-file) below.
2. **FOH position** — click the map where your FOH measurement mic is, or type its x / y (and optional height) in your file's units. If your file has no stage, you can place it here too — seats then face it.
3. **Smaart** — host, port, Smaart version, and the API password if you set one. Press **Test connection**; you'll get a plain answer such as *"Connected and logged in to Smaart"* or *"Nothing is listening at localhost:26000 — start Smaart and enable its API."* You can skip this and connect later.
4. **Save** — the venue opens.

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

With one mic, that's it: FOH uses the first calibrated input and the first running spectrum measurement. With more, pick them in **Smaart → Smaart sources**, and choose a **Roaming mic** input and measurement to use **Capture from Smaart** at each seat. **Test** lists what Smaart is offering. Your choices are part of the venue, so they move with venue profiles.

Smaart Suite does all of the above; Smaart RT/LE have spectrum but no SPL metering, and Smaart SPL has SPL but no spectrum (type or import the missing parts).

**Custom field mapping (advanced)** — for other Smaart versions or unusual setups, switch **Data source** to *Custom*: every number Smaart sends is listed under **Live messages** with its path; assign them to **Booth · SPL**, **Roaming mic · SPL**, etc., and paste any commands Smaart needs into **Poll messages**.

### Measure the room

1. Pick a seat (or **Start walk-through** in Room summary).
2. With a roaming measurement mic at seated ear height, press **Capture response** — this saves the seat's frequency response against FOH and its Low / Lo-Mid / HF levels in one go. Or type the seat and booth readings and **Save readings**.
3. The app jumps to the next seat. **Next unmeasured ›** skips to the next seat that's missing data; the progress bar counts toward every seat.

Each seat keeps its readings and response; the map then shows *live FOH + that seat's difference*, adjusted for how the program's spectrum has changed since you measured.

### Data

**Data** exports and imports readings as CSV. Everything is saved automatically.

---

## 5. The auditorium file

Two ways to describe your room. Any consistent unit works (feet, metres, drawing units) — the app sizes seats from the spacing between them.

### JSON (`*.auditorium.json`)

```json
{
  "format": "roomio-auditorium",
  "schemaVersion": 1,
  "name": "Main Auditorium",
  "units": "ft",
  "yAxis": "down",
  "stage": { "x": 0, "y": 0, "label": "Stage" },
  "foh":   { "x": 0, "y": 62 },
  "seats": [
    { "id": "A-1-1", "section": "A", "row": 1, "seat": 1, "x": -12.5, "y": 20 },
    { "id": "A-1-2", "section": "A", "row": 1, "seat": 2, "x": -10.5, "y": 20, "z": 0.5 }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `name` | **yes** | Room name shown in the app |
| `seats[]` | **yes** | 1 – 20,000 seats |
| `seats[].id` | **yes** | Unique label, e.g. `"A-12-4"`. Readings are stored against it — keep it stable |
| `seats[].x`, `seats[].y` | **yes** | Position |
| `seats[].z` | no | Height (balcony, rake) |
| `seats[].section` / `.row` / `.seat` | no | Labels and walk-through order (default section: `Main`) |
| `seats[].rotation` | no | Degrees, 0 = facing up the screen. Default: facing the stage |
| `units` | no | `px` (default), `ft`, `in`, `m`, `cm`, `mm` |
| `yAxis` | no | `down` (default — screen/SVG style) or `up` (CAD style) |
| `stage` | no | Centre front of the stage; seats face it |
| `foh` | no | Suggested FOH position (you can move it in setup) |
| `background` | no | A floor-plan image under the seats: `{ "image": "data:image/svg+xml;base64,…", "x", "y", "width", "height", "opacity" }` (SVG, PNG, JPEG or WebP, up to 25 MB) |

The complete JSON Schema is in [`docs/auditorium.schema.json`](docs/auditorium.schema.json); an example is in [`docs/examples/`](docs/examples/).

### CSV (`seat,x,y,z`)

```csv
seat,x,y,z
A-1-1,-12.5,20,0
A-1-2,-10.5,20,0
B-2-7,4,24.5,0.3
```

- The header line is optional. `z` can be empty.
- Seat labels are split on `-`, space, `_`, `.` or `/`: `A-12-4` → section **A**, row **12**, seat **4**; `12-4` → row 12, seat 4.
- Or add columns named `section`, `row`, `number`.
- Commas, semicolons or tabs all work. Lines starting with `#` are ignored.
- In setup you choose the venue name, units, and whether Y goes up (CAD — the default for CSV) or down.

Exporting from CAD: most CAD tools can export block insertion points (seat blocks) as CSV — keep the seat label, X, Y and Z columns.

---

## 6. Venues, profiles and your data

Everything lives in your user folder:

- macOS: `~/Library/Application Support/Roomio/`
- Windows: `%APPDATA%\Roomio\`

| File | What's in it |
|---|---|
| `venue.json` | The auditorium, FOH position, Smaart settings and field mapping, seat edits (`schemaVersion` 1) |
| `measurements.json` | Seat readings and frequency responses |
| `credentials.json` | The Smaart API password, encrypted with your system keychain |
| `backups/` | Venues replaced by New Venue, Reset or Import |

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
| The auditorium file won't load | Setup lists each problem with its line or seat number — fix those and choose the file again |

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
