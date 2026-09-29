# Focused lattice ops lane notes

## PR313-M1: `ops.batch-*` files excluded from focused lane

The canonical focused lattice ops vitest bundle (`ci_gates/run_focused_lattice_ops_vitest.sh`) intentionally lists only `tests/ops.*-frontend-real.test.ts` slices and related lattice wiring tests. Files matching `tests/ops.batch-*` are batch/integration harnesses and are **not** part of the focused lane guard count, so they do not affect `focused-lattice-ops-bundle-gate` or the 36-file runner inventory.
