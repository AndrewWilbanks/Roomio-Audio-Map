# Auditorium file format

Roomio needs the position of every seat. Give it either:

- a **JSON auditorium file** (`*.auditorium.json`) — full format below, schema in [`auditorium.schema.json`](auditorium.schema.json), or
- a **CSV seat list** with columns `seat,x,y,z`.

Use any unit (feet, metres, drawing units) as long as it's consistent. The app works out seat size from the spacing between seats.

## JSON

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
| `name` | yes | Room name shown in the app |
| `seats[]` | yes | At least one seat; up to 20,000 |
| `seats[].id` | yes | Unique label (`"A-12-4"`). Readings are stored against it, so keep it stable |
| `seats[].x`, `.y` | yes | Position |
| `seats[].z` | no | Height (balconies, rake) |
| `seats[].section`, `.row`, `.seat` | no | Labels and walk-through order. Default section: `Main` |
| `seats[].rotation` | no | Degrees, 0 = facing up the screen. Default: facing the stage |
| `units` | no | `px` (default), `ft`, `in`, `m`, `cm`, `mm` |
| `yAxis` | no | `down` (default, screen/SVG) or `up` (CAD) |
| `stage` | no | Centre front of the stage |
| `foh` | no | Suggested FOH position |
| `background` | no | Floor plan image: `{ "image": "data:image/svg+xml;base64,…", "x", "y", "width", "height", "opacity" }` |

## CSV

```csv
seat,x,y,z
A-1-1,-12.5,20,0
A-1-2,-10.5,20,0
B-2-7,4,24.5,0.3
```

- The header line is optional; without one, columns are read as `seat,x,y,z`.
- `z` may be left empty.
- Seat labels are split on `-`, space, `_`, `.` or `/`: `A-12-4` → section **A**, row **12**, seat **4**; `12-4` → row 12, seat 4.
- Or add explicit columns by header name: `section`, `row`, `number`.
- Commas, semicolons or tabs all work as separators. Lines starting with `#` are ignored.
- In the setup wizard you choose the venue name, units, and whether Y goes up (CAD, the default for CSV) or down.

## Validation

The wizard checks the file before anything is saved and lists every problem (first 25) with its line or seat index, for example:

- `Line 6: seat "A-1-2" is listed twice (also line 3). Seat labels must be unique.`
- `seats[12].x must be a number (found "12,5").`
- `Unsupported "schemaVersion" 2 (this app reads version 1).`

Warnings (the file still loads): no stage set, seats stacked on the same spot.
