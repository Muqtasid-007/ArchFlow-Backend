import * as boardService from '../services/boardService.js';
import { publishBoardEvent } from '../services/boardEvents.js';
import { ApiError } from '../utils/ApiError.js';
import { ROLE_RANK } from '../utils/constants.js';

export async function listBoards(req, res) {
  const boards = await boardService.listBoardsForUser(req.user._id);
  res.json({ boards });
}

export async function createBoard(req, res) {
  const { board } = await boardService.createBoard(req.user._id, req.body);
  res.status(201).json({ board });
}

export async function getBoard(req, res) {
  const { board, role } = await boardService.getBoardForUser(req.params.boardId, req.user._id);
  res.json({ board, role });
}

export async function updateBoard(req, res) {
  const board = await boardService.updateBoardMeta(req.board._id, req.body);
  await publishBoardEvent('board:updated', {
    boardId: String(req.board._id),
    name: board.name,
    description: board.description,
  });
  res.json({ board });
}

export async function deleteBoard(req, res) {
  const ownerId = String(req.board.owner?._id ?? req.board.owner);
  if (ownerId !== String(req.user._id)) {
    throw ApiError.forbidden('Only the board owner can delete it');
  }
  await boardService.deleteBoard(req.board._id);
  await publishBoardEvent('board:deleted', { boardId: String(req.board._id) });
  res.status(204).end();
}

export async function listMembers(req, res) {
  const { board, role } = await boardService.getBoardForUser(req.board._id, req.user._id);
  res.json({ owner: board.owner, members: board.members, role });
}

export async function addMember(req, res) {
  const { board } = await boardService.addMember(req.board._id, req.body);
  res.status(201).json({ board });
}

export async function updateMemberRole(req, res) {
  const { board } = await boardService.updateMemberRole(req.board._id, req.params.userId, req.body.role);
  await publishBoardEvent('board:member-access-changed', {
    boardId: String(req.board._id),
    userId: String(req.params.userId),
  });
  res.json({ board });
}

export async function removeMember(req, res) {
  const isSelf = String(req.params.userId) === String(req.user._id);
  if (!isSelf && ROLE_RANK[req.boardRole] < ROLE_RANK.admin) {
    throw ApiError.forbidden('Only board admins can remove other members');
  }
  await boardService.removeMember(req.board._id, req.params.userId);
  await publishBoardEvent('board:member-access-changed', {
    boardId: String(req.board._id),
    userId: String(req.params.userId),
  });
  res.status(204).end();
}
