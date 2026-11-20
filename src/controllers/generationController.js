import { generateProject, generateZip } from '../services/codegenService.js';
import { getBoardState } from '../services/boardState.js';

async function loadGenerationInput(req) {
  const state = await getBoardState(req.board._id);
  return {
    boardName: req.board.name,
    graph: { nodes: state.graph.nodes, edges: state.graph.edges },
  };
}

export async function previewGeneration(req, res) {
  const input = await loadGenerationInput(req);
  const { files, summary } = generateProject(input);
  res.json({ files, summary });
}

export async function downloadGeneration(req, res) {
  const input = await loadGenerationInput(req);
  const { buffer, filename, summary } = await generateZip(input);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('X-Generated-Files', String(summary.fileCount));
  res.send(buffer);
}
