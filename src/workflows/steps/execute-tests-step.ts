import { z } from "zod";
import { createStep } from "@mastra/core/workflows";
import { generateTestPlanStep } from "./generate-test-plan-step";
import { previewEnvironmentOutputSchema } from "./wait-for-preview-environment-step";
import { BrowserUseClient } from "browser-use-sdk";

export const testExecutionOutputSchema = z.object({
  needsTesting: z.boolean(),
  testCases: z.array(
    z.object({
      title: z.string(),
      status: z.enum(["success", "fail"]),
    })
  ),
});

export const executeTestsStep = createStep({
  id: "execute-tests",
  inputSchema: previewEnvironmentOutputSchema,
  outputSchema: testExecutionOutputSchema,

  execute: async (context) => {
    const testPlanResult = context.getStepResult(generateTestPlanStep);

    if (!testPlanResult) {
      throw new Error("Test plan step result not found");
    }

    const { testCases, needsTesting } = testPlanResult;

    if (!needsTesting) {
      return {
        needsTesting: false,
        testCases: [],
      };
    }

    const client = new BrowserUseClient({
      apiKey: process.env.BROWSER_USE_API_KEY!,
    });

    const executedTestCases = await Promise.all(
      testCases.map(async (testCase) => {
        try {
          const taskResponse = await client.tasks.createTask({
            task: `Navigate to ${context.inputData.previewUrl} and execute this test case: ${testCase.title}. ${testCase.description}`,
          });

          // Poll for task completion with timeout
          const POLL_INTERVAL_MS = 2000;
          const MAX_POLL_TIME_MS = 5 * 60 * 1000; // 5 minutes timeout
          const startTime = Date.now();

          const pollForCompletion = async (): Promise<any> => {
            const task = await client.tasks.getTask(taskResponse.id);

            // Task is still in progress if it's not finished or stopped
            const isInProgress = task.status !== "finished" && task.status !== "stopped";

            if (isInProgress) {
              if (Date.now() - startTime > MAX_POLL_TIME_MS) {
                throw new Error(
                  `Task ${taskResponse.id} timed out after ${MAX_POLL_TIME_MS / 1000} seconds`
                );
              }
              await new Promise((resolve) =>
                setTimeout(resolve, POLL_INTERVAL_MS)
              );
              return pollForCompletion();
            }

            console.log(`[Poll] Task ${taskResponse.id} completed with status: ${task.status}`);
            return task;
          };

          const task = await pollForCompletion();

          // Determine if the test passed based on the result
          const status = task.isSuccess === true ? "success" : "fail";
          return {
            title: testCase.title,
            status: status as "success" | "fail",
          };
        } catch (error) {
          console.error(`Test case "${testCase.title}" failed:`, error);
          return {
            title: testCase.title,
            status: "fail" as const,
          };
        }
      })
    );

    return {
      needsTesting: true,
      testCases: executedTestCases,
    };
  },
});
