import type { ReviewData } from "./relay-trajectory-viewer/page.js";
export type { CommandOutput, Reason, ReviewData, ReviewPageStep, StepDetail } from "./relay-trajectory-viewer/page.js";
/** The steps, verdicts and reasons of the package in `dir`, with each step's snapshots as package paths. */
export declare const reviewData: (dir: string) => Promise<ReviewData>;
