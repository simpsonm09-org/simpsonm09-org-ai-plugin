---
name: machine-inventory
description: Use when a task depends on the fleet machines, such as choosing where a build or a service runs, checking a machine's storage class, GPU, or always-on status, or explaining the workspace layout. Reads the simpsonm09-machine-inventory records.
---

# Machine inventory

The fleet machine classes live in the `simpsonm09-machine-inventory` repository, cloned in the workspace at `projects/repos/simpsonm09-machine-inventory`. Each machine is one record at `machines/<id>.json`, and the repository README renders the same records as a table.

## Read the records

Read `projects/repos/simpsonm09-machine-inventory/machines/*.json`. Each record holds:

- `id`: a non-identifying label such as `desktop-primary`.
- `role`: `workstation`, `server`, or `runner`.
- `storageClass`: `storage-ample` for a fast NVMe SSD with room to spare, `storage-constrained` for a small or nearly full fast disk.
- `os`, `cpu` core and thread counts, `ramTier`, `gpu` class, `disks` counts by class, and the capability flags `docker`, `wsl`, `gpuCompute`, and `alwaysOn`.

## Use it

- To pick where a build or a service runs, match the need to `gpuCompute`, `docker`, `storageClass`, and `alwaysOn`.
- To size work, use `ramTier` and the `cpu` counts.
- The repository is public and non-identifying. Never add a hostname, username, serial, drive path, IP, or MAC to a record.
- To add a machine, run the repository collector on that machine. Do not hand-invent a record.

## Rules

- The records are declared classes and buckets, not live state. Treat them as intent, not a monitor.
- The repository owns its schema and validation. This skill only points at the records.
