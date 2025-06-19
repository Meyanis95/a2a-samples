import express from "express";
import { v4 as uuidv4 } from "uuid"; // For generating unique IDs

import {
  InMemoryTaskStore,
  TaskStore,
  schema,
  A2AExpressApp,
  AgentExecutor,
  RequestContext,
  IExecutionEventBus,
  DefaultRequestHandler,
} from "../../server/index.js";
import { MessageData } from "genkit";
import generateProtocol from "../../mpcf/generateProtocol.js";
import { ai, z } from "./genkit.js";
import assert from "assert";
import { WebSocketServer, WebSocket } from "ws";

const PORT = 8081;
const wss = new WebSocketServer({
  port: PORT,
});
console.info(`[Bob] MPC Host is listening on ws://localhost:${PORT}`);

wss.on("connection", async (bobWs) => {
  console.log("[Bob] Received a connection from Alice.");
  bobWs.on("error", console.error);

  const protocol = await generateProtocol("./src/mpcf/circuits/main.ts");
  const bobNumber = 42; // Bob's secret number

  const session = protocol.join("bob", { b: bobNumber }, (to, msg) => {
    assert(to === "alice", "Unexpected party");
    bobWs.send(msg);
  });

  bobWs.on("message", (msg: Buffer) => {
    session.handleMessage("alice", new Uint8Array(msg));
  });

  session.output().then(({ main }) => {
    console.log(`[Bob] MPC computation finished. Result code: ${main}`);
    bobWs.close(); // Close the connection after the protocol is done
  });
});

if (!process.env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY environment variable is required");
  process.exit(1);
}

// Simple store for contexts
const contexts: Map<string, schema.Message[]> = new Map();

export const mpcGuessNumber = ai.defineTool(
  {
    name: "guessNumber",
    description: "Engage in a game of guessing a number between 1 and 100.",
    inputSchema: z.object({ query: z.string() }),
  },
  async ({ query }) => {
    return new Promise((resolve, reject) => {
      const aliceWs = new WebSocket(`ws://localhost:${PORT}`); // Connect to Bob
      aliceWs.on("error", reject);
      aliceWs.on("open", async () => {
        try {
          const protocol = await generateProtocol(
            "./src/mpcf/circuits/main.ts"
          );
          const session = protocol.join(
            "alice",
            { a: Number(query) },
            (to, msg) => {
              aliceWs.send(msg);
            }
          );
          aliceWs.on("message", (msg: Buffer) =>
            session.handleMessage("bob", msg)
          );
          const { main } = await session.output();
          aliceWs.close();
          resolve({
            result: `Your number is ${
              main === 0 ? "equal" : main === 1 ? "larger" : "smaller"
            }`,
          });
        } catch (err) {
          aliceWs.close();
          reject(err);
        }
      });
    });
  }
);

// --- Server Setup ---

class MPCFAgentExecutor implements AgentExecutor {
  async execute(
    requestContext: RequestContext,
    eventBus: IExecutionEventBus
  ): Promise<void> {
    // This executor now only handles non-MPC conversational tasks.
    // For this demo, we just reply with a helpful message.
    const taskId = requestContext.task?.id || uuidv4();
    const contextId = requestContext.userMessage.contextId || uuidv4();

    const agentMessage: schema.Message = {
      kind: "message",
      role: "agent",
      messageId: uuidv4(),
      parts: [
        {
          kind: "text",
          text: "Hello! I am the MPCF Agent. To start a secure number comparison, please use the `/mpc <your-number>` command in your CLI.",
        },
      ],
      taskId: taskId,
      contextId: contextId,
    };

    const finalUpdate: schema.TaskStatusUpdateEvent = {
      kind: "status-update",
      taskId: taskId,
      contextId: contextId,
      status: {
        state: schema.TaskState.Completed,
        message: agentMessage,
        timestamp: new Date().toISOString(),
      },
      final: true,
    };
    eventBus.publish(finalUpdate);
  }
}

const mpcfAgentCard: schema.AgentCard = {
  name: "MPCF Agent",
  description:
    "An agent that can answer questions about movies and actors using TMDB.",
  // Adjust the base URL and port as needed. /a2a is the default base in A2AExpressApp
  url: "http://localhost:41244/", // Example: if baseUrl in A2AExpressApp
  provider: {
    organization: "A2A Samples",
    url: "https://example.com/a2a-samples", // Added provider URL
  },
  version: "0.0.2", // Incremented version
  capabilities: {
    streaming: true, // The new framework supports streaming
    pushNotifications: false, // Assuming not implemented for this agent yet
    stateTransitionHistory: true, // Agent uses history
  },
  // authentication: null, // Property 'authentication' does not exist on type 'AgentCard'.
  securitySchemes: undefined, // Or define actual security schemes if any
  security: undefined,
  defaultInputModes: ["text"],
  defaultOutputModes: ["text", "task-status"], // task-status is a common output mode
  skills: [
    {
      id: "guess_number_chat",
      name: "Guess the Number Chat",
      description: "Engage in a game of guessing a number between 1 and 100.",
      tags: ["games", "numbers", "guessing"],
      examples: [
        "I'm thinking of a number between 1 and 100. Can you guess it?",
        "Is it 50?",
      ],
      inputModes: ["text"], // Explicitly defining for skill
      outputModes: ["text", "task-status"], // Explicitly defining for skill
    },
  ],
  supportsAuthenticatedExtendedCard: false,
};

async function main() {
  // 1. Create TaskStore
  const taskStore: TaskStore = new InMemoryTaskStore();

  // 2. Create AgentExecutor
  const agentExecutor: AgentExecutor = new MPCFAgentExecutor();

  // 3. Create DefaultRequestHandler
  const requestHandler = new DefaultRequestHandler(
    mpcfAgentCard,
    taskStore,
    agentExecutor
  );

  // 4. Create and setup A2AExpressApp
  const appBuilder = new A2AExpressApp(requestHandler);
  const expressApp = appBuilder.setupRoutes(express());

  // 5. Start the server
  const PORT = process.env.PORT || 41244;
  expressApp.listen(PORT, () => {
    console.log(
      `[MPCFAgent] Server using new framework started on http://localhost:${PORT}`
    );
    console.log(
      `[MPCFAgent] Agent Card: http://localhost:${PORT}/.well-known/agent.json`
    );
    console.log("[MPCFAgent] Press Ctrl+C to stop the server");
  });
}

main().catch(console.error);
