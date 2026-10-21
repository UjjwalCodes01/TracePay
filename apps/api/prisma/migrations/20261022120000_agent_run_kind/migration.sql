-- Shopping Assistant runs share the agent run tables with the Publisher Agent.
CREATE TYPE "AgentRunKind" AS ENUM ('publisher', 'buyer');

ALTER TABLE "AgentRun" ADD COLUMN "kind" "AgentRunKind" NOT NULL DEFAULT 'publisher';
