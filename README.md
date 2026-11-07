# BioSentry ward simulation

An interactive demo of how BioSentry Intelligence would behave on a live ward. Twelve synthetic patients wear chest patches on ward W4. Samples travel through the pipeline, the ranked list changes, and nurses and physicians respond.

Advisory only. BioSentry does not replace a monitor alarm. Every patient, name and number here is synthetic.

## Run it

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

`npm install` needs the committed `package-lock.json`. Without it, npm 10 fails while resolving Vitest's optional peers.

## What you can do

- Set the speed: pause, 1x, 10x or 60x. Staff movement is capped at 6x so walks stay visible.
- Click a bed or a ranked row to open a chart with the five vitals: heart rate, respiratory rate, SpO2, temperature and blood pressure.
- Start a deterioration, detach a patch, apply a patch, or record a blood pressure.
- Open Pipeline for stage counts and Log for ward events.

## How it works

| Stage | Where |
|---|---|
| Vitals source, the seam for a real dataset | `src/sim/source.ts` |
| Quality gate, staff loop, commands | `src/sim/sim.ts` |
| NEWS2, ported from BioSentry | `src/sim/news2.ts` |
| Arbiter and ranking, ported from BioSentry | `src/sim/arbiter.ts` |
| Ward map and pathing | `src/sim/map.ts` |
| Isometric renderer and sprites | `src/render/` |
| Panels | `src/panels.tsx` |

The sim is plain data with no React or canvas, so it runs headless in tests. At minute 0 it reproduces the BioSentry fixture: all ten NEWS2 totals, the rank order, the reason strings and the NOT RANKED text. `src/sim/sim.test.ts` checks this against `src/sim/synthetic.json`.

### Plugging in a dataset

Implement `VitalsSource` and pass it to `createSim`:

```ts
interface VitalsSource {
  readonly synthetic: boolean;
  read(patientId: string, minute: number): DeviceReading | null;
  cuff(patientId: string, minute: number): { systolic: number; diastolic: number } | null;
  inject?(patientId: string, minute: number): void;
}
```

Set `synthetic` to `false` and the badge goes away. Leave out `inject` and the deterioration button goes away. A null reading follows the same path as lost signal, so a dataset with no temperature or blood pressure would leave most patients NOT RANKED. Check channel coverage first.

## What is demo design, not product

BioSentry only ranks and displays. A human decides. These parts were invented for this demo:

- **Staff response loop:** the product has no alert or acknowledgement flow. Messages, walks, assessments and physician calls are demo design.
- **Reassessment:** medium and high risk patients are seen at least every 60 sim-minutes.
- **Quality gate:** a 15-minute median of 8 or more usable readings, degraded after 15 stale minutes.
- **NOT RANKED cutoff:** 30 stale minutes.
- **Filled fixture gaps:** a cuff reading of 128/76 for p-004, a baseline for p-005, and physicians for both.
- **Hardware:** the patch, gateway and edge server are the described design. None of it is built.

The demo deliberately shows no recovery after review and no response-time figures. Either would imply an outcome benefit the product does not claim.

## Art

All art is drawn in this repository's code, in `src/render/`. The panel layout and status palette take their idiom from [Munder Difflin](https://github.com/HarnessMD/munder-difflin) (MIT). None of its assets are used.

## Before sharing publicly

BioSentry's NEWS2 model card lists the licence as unverified. Resolve that before making this repository or demo public.
