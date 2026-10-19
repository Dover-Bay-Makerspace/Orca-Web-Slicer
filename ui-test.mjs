// Main-thread side of workers/project-worker.js (3MF / OrcaSlicer project reader).

const worker = new Worker(new URL('../workers/project-worker.js', import.meta.url));
let nextId = 1;
const pending = new Map();

worker.onmessage = (event) => {
  const { id, ok, project, error } = event.data;
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (ok) p.resolve(project); else p.reject(new Error(error));
};

/**
 * Read a .3mf file. `bed` ({ width, depth }) is only used when the project
 * itself doesn't record its printer's bed size.
 */
export function readProjectFile(bytes, bed) {
  const id = nextId++;
  const copy = bytes.slice().buffer;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, bytes: copy, bed: bed ? { width: bed.width, depth: bed.depth } : null }, [copy]);
  });
}
