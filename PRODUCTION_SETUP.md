# Production Setup on Domino Data Lab

End-to-end runbook for the drone-simulator production demo. Maps each architecture
component to the code that implements it and the Domino feature that hosts it.

| Component | Code | Domino feature |
|-----------|------|----------------|
| Flight simulator web app | [packages/web/](packages/web/) + [app.sh](app.sh) | **Domino App** |
| Simulation at scale | [packages/ml/01_simulation.ipynb](packages/ml/01_simulation.ipynb), [cfd_solver.py](packages/ml/cfd_solver.py) | **On-demand Ray cluster** |
| Experiment tracking + registry | [packages/ml/02_training.ipynb](packages/ml/02_training.ipynb) | **MLflow (Experiment Manager + Model Registry)** |
| Wind-correction inference | [packages/ml/model_api.py](packages/ml/model_api.py) | **Model API** |
| YOLO detection + intel report | [packages/python-yolo/main.py](packages/python-yolo/main.py) | **Model API or sidecar App** |
| CFD flow fields | [cfd_solver.py](packages/ml/cfd_solver.py) → JSON | **Domino project files / Dataset** |

---

## Phase 0 — Project & environments

1. **Create the project from Git** (Projects → New → Git-based) pointing at this repo,
   branch `michael-edits` (or merge to `main` first).

2. **Build two compute environments** (Environments → New):
   - **`drone-ml`** — base image with CUDA if you want GPU training. Install
     `packages/ml/requirements.txt` (Ray, PyTorch, MLflow, PyVista, etc.) and **Node 20+**
     (the App uses it; or rely on the bootstrap in `app.sh`).
   - **`drone-yolo`** — install `packages/python-yolo/requirements.txt`
     (ultralytics, openai, fastapi).

---

## Phase 1 — Simulation at scale (Ray)

[01_simulation.ipynb](packages/ml/01_simulation.ipynb) fans out per-aircraft simulations
with `@ray.remote` and writes training data to `data/*.parquet`.

1. Launch a **Workspace** (or **Job**) on `drone-ml` and **attach an on-demand Ray cluster**
   (Workspace settings → Compute Cluster → Ray → 30 workers).
2. In the notebook, switch the init line from local to cluster:
   ```python
   ray.init(address="auto")   # connects to the Domino-provisioned cluster head
   ```
   (Local fallback `ray.init()` uses all cores on a single node.)
3. Run `ray_simulation(AIRCRAFT_IDS, batch_size=50)`. Output parquet lands in `data/`.
4. **Generate CFD flow fields** via [cfd_solver.py](packages/ml/cfd_solver.py) `run_simulation(...)`
   — also a Ray task. Save the results as `flow_fields/{aircraft_id}_*.json`.

**Persist the outputs** so they survive the cluster teardown:
- Commit small artifacts to project files, **or**
- Write large data to a **Domino Dataset** (`/domino/datasets/local/<name>/`) for versioning.

> Run this as a **scheduled Job** if you want the data regenerated on a cadence.

---

## Phase 2 — Training + MLflow registry

[02_training.ipynb](packages/ml/02_training.ipynb) trains one PyTorch
`WindCorrectionNet` per aircraft and registers each in the Model Registry.

1. Point MLflow at Domino (it's pre-wired in Domino workspaces — you can drop the explicit
   `set_tracking_uri` and Domino injects it). The notebook calls:
   ```python
   mlflow.set_experiment(experiment_name)
   mlflow.start_run(run_name=f"{aircraft_id}_v1")
   mlflow.log_params(HYPERPARAMS); mlflow.log_metrics({...})
   mlflow.pytorch.log_model(model, "model",
       registered_model_name=f"wind-correction-{aircraft_id}")
   ```
2. Run all cells on `drone-ml` (reads the parquet from Phase 1).
3. Each aircraft produces a registered model `wind-correction-<id>` plus artifacts
   `wind_correction_<id>.pt` and `feature_scaler_<id>.pkl`.
4. Confirm runs appear under **Experiments** and models under **Model Registry**.

---

## Phase 3 — Wind-correction Model API

[model_api.py](packages/ml/model_api.py) exposes `predict(data)` and loads artifacts from
`DOMINO_ARTIFACTS_DIR` → falls back to `/mnt/artifacts` → `./models`. **One endpoint serves
all aircraft** (it reads `data["aircraft_id"]`).

1. **Publish → Model APIs → New Model**
   - File: `packages/ml/model_api.py`, function: `predict`
   - Environment: `drone-ml`
2. Make the `.pt` / `.pkl` artifacts reachable at `DOMINO_ARTIFACTS_DIR` (set the env var to
   wherever Phase 1/2 stored them, e.g. a Dataset mount, or copy them into `packages/ml/models/`).
3. Test with the documented payload:
   ```json
   { "data": { "aircraft_id": "x47b", "speed": 200.0, "heading": 45.0,
     "pitch": 2.0, "roll": -5.0, "vertical_velocity": 0.5,
     "wind_dir": 90.0, "wind_speed": 25.0, "turbulence": 0.6 } }
   ```
4. Note the **invocation URL** and **access token** — used by the App in Phase 5.

---

## Phase 4 — YOLO detection + intel report

[python-yolo/main.py](packages/python-yolo/main.py) runs `YOLOv8m-OBB` and calls OpenAI.
`/detect` takes a **multipart image upload**, `/analyze` takes JSON. It needs
`OPENAI_API_KEY` (env var or `.env`).

Two hosting options:
- **(Recommended) Sidecar Domino App** — deploy this FastAPI service as its own App bound to
  `0.0.0.0:8888`. It already serves `/detect` and `/analyze` over HTTP, matching what the
  frontend expects, so **no request-shape adapter is needed**.
- **Model API** — works for `/analyze` (JSON) but `/detect`'s binary upload doesn't fit the
  Model API `{"data": {...}}` envelope without base64 encoding + an adapter.

Set `OPENAI_API_KEY` via the App/Model env vars. Prefer routing OpenAI through the
**Domino AI Gateway** for centralized keys and usage monitoring.

---

## Phase 5 — The Domino App (frontend)

[app.sh](app.sh) + [packages/web/vite.config.ts](packages/web/vite.config.ts) run the Vite
frontend behind Domino's proxy. **No GPU** — rendering is client-side WebGL; use a small CPU tier.

**Publish → App**, environment `drone-ml` (has Node), and set env vars:

| Var | Purpose |
|-----|---------|
| `VITE_CESIUM_TOKEN` | Cesium ion globe + terrain (app gates without it) |
| `VITE_MAPBOX_TOKEN` | mini-map |
| `YOLO_API_URL` | Phase 4 service `/detect` + `/analyze` base URL |
| `ML_API_URL` | Phase 3 wind-correct Model API URL |
| `MODEL_API_TOKEN` | bearer token for the Model APIs |

---

## ⚠️ Integration gaps to close before the demo is fully wired

The launch scaffolding routes `/api/*`, but three shape mismatches remain between the
frontend's expectations and the Domino Model API contract:

1. **`/api/wind-tunnel` has no production backend.** `model_api.py` only implements
   wind-*correction*. The pre-computed CFD flow fields must be served — either bundle the
   `flow_fields/*.json` into the App's static assets (the README's "app serves stored flow
   fields instantly" approach) or stand up a small endpoint like dev's
   [model_server.py](packages/ml/model_server.py) `/wind-tunnel`.

2. **Request envelope.** Domino Model APIs expect `{"data": {...}}` and return `{"result": ...}`.
   The frontend's `fetch('/api/wind-correct', ...)` sends/expects raw shapes. The Vite proxy
   currently only rewrites the path + adds a bearer header — it does **not** reshape bodies.

3. **`/api/detect` image upload** doesn't fit the Model API JSON envelope (hence the
   "sidecar App" recommendation in Phase 4).

I can write the adapter layer (proxy body-reshaping + flow-field serving) to close these — ask
when you're ready.

---

## Quick dependency order

```
Phase 0 (project + envs)
  └─ Phase 1 (Ray sim → parquet + flow_fields)
       └─ Phase 2 (MLflow training → registered models)
            └─ Phase 3 (wind-correct Model API)
Phase 4 (YOLO/OpenAI service)  ─┐
Phase 5 (App)  ←── needs URLs from Phases 3 & 4
```
