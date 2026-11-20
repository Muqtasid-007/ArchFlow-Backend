import mongoose from 'mongoose';
import { graphSchema } from './graphSchema.js';
import { ROLES } from '../utils/constants.js';

const memberSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ROLES, default: 'editor' },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const boardSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 80,
    },
    description: { type: String, trim: true, default: '', maxlength: 300 },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    members: {
      type: [memberSchema],
      default: [],
      validate: {
        validator: (members) => members.length <= 50,
        message: 'A board can have at most 50 members',
      },
    },
    graph: { type: graphSchema, default: () => ({ nodes: [], edges: [] }) },
    revision: { type: Number, default: 1, min: 1 },
    lastEditedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    archived: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        return ret;
      },
    },
  },
);

boardSchema.index({ 'members.user': 1, updatedAt: -1 });
boardSchema.index({ owner: 1, updatedAt: -1 });

boardSchema.methods.roleOf = function roleOf(userId) {
  const id = String(userId);
  if (this.owner && String(this.owner._id ?? this.owner) === id) return 'admin';
  const member = this.members.find((entry) => String(entry.user?._id ?? entry.user) === id);
  return member ? member.role : null;
};

boardSchema.methods.isMember = function isMember(userId) {
  return this.roleOf(userId) !== null;
};

export const Board = mongoose.model('Board', boardSchema);
