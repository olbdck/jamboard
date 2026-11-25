# Performance bench (dev only)

Runs the board in headless Chromium against an in-memory stand-in for Supabase (`mock.js`), on a generated big board
(`gen.js`: 20 sections, 1500 stickies, 150 texts, 150 diagram blocks with 200 wires, 150 ropes).

    node tools/perf/bench.js <site dir> <label> [scale]   # e.g. node tools/perf/bench.js . after
    THR=4 node tools/perf/bench.js . after                 # with 4x CPU throttling
    node tools/perf/e2e.js .                               # quick check of hover ports, ropes, undo, drag, remote edits, zoom

Each scenario prints main-thread CPU per second (`cpuPerSec_ms`), script / layout / style time and frame gaps.
In the cloud container there is no GPU, so frame gaps are bound by software compositing; compare the main-thread numbers.
Results are written to `tools/perf/res-<label>.json` (not committed).
