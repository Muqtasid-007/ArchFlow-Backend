import mongoose from 'mongoose';
import { Board } from '../models/Board.js';
import { ApiError } from '../utils/ApiError.js';
import { flushBoard, invalidateBoard } from './boardState.js';

const PUBLIC_USER_FIELDS = 'name email avatarColor';

/** Owner/member role check that works on lean documents too. */
export function roleOfLean(board, userId) {
  const id = String(userId);
  if (String(board.owner?._id ?? board.owner) === id) return 'admin';
  const member = (board.members ?? []).find((entry) => String(entry.user?._id ?? entry.user) === id);
  return member?.role ?? null;
}

function serializeBoard(board) {
  const graph = board.graph ?? { nodes: [], edges: [] };
  return {
    id: String(board._id ?? board.id),
    name: board.name,
    description: board.description ?? '',
    owner: board.owner,
    members: board.members ?? [],
    graph: { nodes: graph.nodes ?? [], edges: graph.edges ?? [] },
    revision: board.revision ?? 1,
    archived: Boolean(board.archived),
    lastEditedBy: board.lastEditedBy ?? null,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
  };
}

export async function listBoardsForUser(userId) {
  const boards = await Board.find({ $or: [{ owner: userId }, { 'members.user': userId }] })
    .select('name description owner members revision archived createdAt updatedAt')
    .populate('owner', PUBLIC_USER_FIELDS)
    .populate('members.user', PUBLIC_USER_FIELDS)
    .sort({ updatedAt: -1 })
    .lean();

  return boards.map((board) => ({
    id: String(board._id),
    name: board.name,
    description: board.description ?? '',
    owner: board.owner,
    members: board.members ?? [],
    memberCount: board.members?.length ?? 0,
    revision: board.revision ?? 1,
    archived: Boolean(board.archived),
    role: roleOfLean(board, userId),
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
  }));
}

export async function createBoard(userId, { name, description = '' }) {
  const board = await Board.create({ name, description, owner: userId, members: [], graph: { nodes: [], edges: [] } });
  return getBoardForUser(board._id, userId);
}

export async function getBoardForUser(boardId, userId) {
  if (!mongoose.isValidObjectId(boardId)) throw ApiError.notFound('Board not found');

  const board = await Board.findById(boardId)
    .populate('owner', PUBLIC_USER_FIELDS)
    .populate('members.user', PUBLIC_USER_FIELDS);

  if (!board) throw ApiError.notFound('Board not found');

  const role = board.roleOf(userId);
  if (!role) throw ApiError.forbidden('You are not a member of this board');

  return { board: { ...serializeBoard(board), role }, role };
}

export async function updateBoardMeta(boardId, updates) {
  const board = await Board.findByIdAndUpdate(boardId, { $set: updates }, { new: true, runValidators: true })
    .populate('owner', PUBLIC_USER_FIELDS)
    .populate('members.user', PUBLIC_USER_FIELDS);

  if (!board) throw ApiError.notFound('Board not found');
  return serializeBoard(board);
}

export async function deleteBoard(boardId) {
  const board = await Board.findById(boardId);
  if (!board) throw ApiError.notFound('Board not found');
  await Board.deleteOne({ _id: boardId });
  await invalidateBoard(boardId);
}

export async function addMember(boardId, { email, role }) {
  const User = mongoose.model('User');
  const user = await User.findByEmail(email);
  if (!user) throw ApiError.notFound('No ArchFlow account exists for that email');

  const board = await Board.findById(boardId);
  if (!board) throw ApiError.notFound('Board not found');
  if (String(board.owner) === String(user._id)) throw ApiError.conflict('The board owner is already an admin');
  if (board.members.some((member) => String(member.user) === String(user._id))) {
    throw ApiError.conflict('That person is already a member of this board');
  }
  if (board.members.length >= 50) throw ApiError.badRequest('This board has reached its member limit');

  board.members.push({ user: user._id, role });
  await board.save();
  return getBoardForUser(boardId, board.owner);
}

export async function updateMemberRole(boardId, memberUserId, role) {
  const board = await Board.findById(boardId);
  if (!board) throw ApiError.notFound('Board not found');
  if (String(board.owner) === String(memberUserId)) {
    throw ApiError.badRequest('The board owner always keeps the admin role');
  }

  const member = board.members.find((entry) => String(entry.user) === String(memberUserId));
  if (!member) throw ApiError.notFound('Member not found');

  member.role = role;
  await board.save();
  return getBoardForUser(boardId, board.owner);
}

export async function removeMember(boardId, memberUserId) {
  const board = await Board.findById(boardId);
  if (!board) throw ApiError.notFound('Board not found');
  if (String(board.owner) === String(memberUserId)) {
    throw ApiError.badRequest('The owner cannot be removed from the board');
  }

  const before = board.members.length;
  board.members = board.members.filter((entry) => String(entry.user) !== String(memberUserId));
  if (board.members.length === before) throw ApiError.notFound('Member not found');

  await board.save();
  return getBoardForUser(boardId, board.owner);
}

/**
 * Persists the live graph and returns the board document for snapshots.
 */
export async function loadFreshGraph(boardId) {
  await flushBoard(boardId);
  const board = await Board.findById(boardId).lean();
  if (!board) throw ApiError.notFound('Board not found');
  return board;
}
