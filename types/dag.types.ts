// types/dag.types.ts
// DAG (Directed Acyclic Graph) structure — produced by the Planner agent
// and consumed by the CustomExecutor.

/** A single node in the DAG. */
export interface DagNode {
  /** Node identifier within the run, e.g. "n1", "n2". */
  id: string
  /** Agent type: CLASSIFIER | PLANNER | WRITER | REVIEWER | QA | DEVOPS */
  agent_type: string
  /** Optional per-node config overrides. */
  config?: Record<string, unknown>
}

/** A directed edge from one node to another (dependency arrow). */
export interface DagEdge {
  /** Source node id (must complete before `to` can start). */
  from: string
  /** Target node id. */
  to: string
}

/** Full DAG structure stored in `Run.dag`. */
export interface Dag {
  nodes: DagNode[]
  edges: DagEdge[]
}
