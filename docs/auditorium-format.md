# Auditorium file format

A Roomio room is a set of **areas**: named outlines of the parts of the room you measure and
compare (*Front Left*, *Centre*, *Balcony*…). The easiest way to make one is a **floor plan** (PDF,
PNG, JPEG or SVG): in setup you click the corners of each area and Roomio writes this format for you
(see the README, *Start from a floor plan*). To make the file yourself, give it either:

- a **JSON auditorium file** (`*.auditorium.json`, version 2) — format below, schema in [`auditorium.schema.json`](auditorium.schema.json), or
- a **seat list** — a CSV with columns `seat,x,y,z`, or a version-1 JSON file — which is grouped into one area per section.

Use any unit (feet, metres, drawing units) as long as it's consistent.

## JSON (version 2)

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
| `name` | yes | Room name shown in the app |
| `areas[]` | yes | 1 – 500 areas, in walk-through order |
| `areas[].id` | yes | Unique label (`"front-left"`). Readings are stored against it, so keep it stable |
| `areas[].name` | no | Shown on the map. Default: the id |
| `areas[].points` | yes | The outline: 3 – 1000 corners as `[x, y]`, in order around the edge (not repeating the first) |
| `areas[].z` | no | Height (balconies, rake) |
| `units` | no | `px` (default), `ft`, `in`, `m`, `cm`, `mm` |
| `yAxis` | no | `down` (default, screen/SVG) or `up` (CAD) |
| `stage` | no | Centre front of the stage (shown for orientation) |
| `foh` | no | Suggested FOH position |
| `background` | no | Floor plan image: `{ "image": "data:image/png;base64,…", "x", "y", "width", "height", "opacity" }` (SVG, PNG, JPEG or WebP, up to 25 MB) |

## Seat lists

### Version 1 JSON

Files from Roomio 0.1.x list individual seats: `"schemaVersion": 1`, `"seats": [{ "id": "A-1-1", "section": "A", "x": 0, "y": 0, "z": 0 }]`.
They still load: each `section` (default `Main`) becomes one area, outlined around its seats with
half a seat's spacing to spare. Seat ids are remembered so readings taken at a seat follow it into
its area.

### CSV

```csv
seat,x,y,z
A-1-1,-12.5,20,0
A-1-2,-10.5,20,0
B-2-7,4,24.5,0.3
```

- The header line is optional; without one, columns are read as `seat,x,y,z`. `z` may be left empty.
- The section comes from a `section` column, or from labels like `A-12-4` (section **A**; split on `-`, space, `_`, `.` or `/`).
- Commas, semicolons or tabs all work as separators. Lines starting with `#` are ignored.
- In the setup wizard you choose the venue name, units, and whether Y goes up (CAD, the default for CSV) or down.

## Validation

The wizard checks the file before anything is saved and lists every problem (first 25) with its line, area or seat index, for example:

- `areas[2].points needs at least 3 corners, like [[0,0],[10,0],[10,8]].`
- `areas[4].id "centre" is used twice (also areas[1]). Area ids must be unique.`
- `Line 6: seat "A-1-2" is listed twice (also line 3). Seat labels must be unique.`

Warnings (the file still loads): no stage set; a seat list was grouped into areas.
