import { parentPort, workerData } from "node:worker_threads";
import { project2d } from "./pca.js";
parentPort?.postMessage(project2d(workerData as number[][]));
