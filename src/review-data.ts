// The review data of a delivered package, for programs that read relay
// packages: `@wezzard/mcp-vm-relay/review-data`. It is the derivation the review
// app shows (docs/design.md, "Derive at review"): steps, verdicts and reasons,
// derived from the raw evidence by this relay's rules. It reads the package and
// writes nothing; verify the package first with the trajectory review command
// if its integrity matters.
import { reviewData as derive } from "./package.js";
import type { ReviewData } from "./review-page.js";

export type { CommandOutput, Reason, ReviewData, ReviewPageStep, StepDetail } from "./review-page.js";
/** The steps, verdicts and reasons of the package in `dir`, with each step's snapshots as package paths. */
export const reviewData: (dir: string) => Promise<ReviewData> = derive;
