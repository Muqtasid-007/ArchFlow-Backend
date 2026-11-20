import mongoose from 'mongoose';
import { Board } from '../models/Board.js';
import { ApiError } from '../utils/ApiError.js';
import { ROLE_RANK } from '../utils/constants.js';

/**
 * Loads `req.board` from `:boardId` and `req.boardRole` for the current user.
 * Membership in any role is required to see a board at all.
 */
export async function loadBoard(req, _res, next) {
  const { boardId } = req.params;
  if (!mongoose.isValidObjectId(boardId)) throw ApiError.notFound('Board not found');

  const board = await Board.findById(boardId);
  if (!board) throw ApiError.notFound('Board not found');

  const role = board.roleOf(req.user._id);
  if (!role) throw ApiError.forbidden('You are not a member of this board');

  req.board = board;
  req.boardRole = role;
  next();
}

/** Guard a route with a minimum board role: viewer < editor < admin. */
export function requireBoardRole(minimumRole) {
  return function boardRoleGuard(req, _res, next) {
    const role = req.boardRole ?? req.board?.roleOf(req.user._id);
    if (!role) throw ApiError.forbidden('You are not a member of this board');

    if (ROLE_RANK[role] < ROLE_RANK[minimumRole]) {
      throw ApiError.forbidden(`This action requires the ${minimumRole} role`);
    }
    next();
  };
}
