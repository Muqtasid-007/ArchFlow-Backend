import { analyzeArchitecture } from '../services/aiService.js';
import { getBoardState } from '../services/boardState.js';

export async function analyzeBoard(req, res) {
  // Always review the live cached graph so unsaved drag/connect changes count.
  const state = await getBoardState(req.board._id);
  const review = await analyzeArchitecture({ nodes: state.graph.nodes, edges: state.graph.edges });
  res.json({ review, revision: state.revision });
}
