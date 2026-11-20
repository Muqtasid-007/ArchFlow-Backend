import mongoose from 'mongoose';
import { graphSchema } from './graphSchema.js';

const snapshotSchema = new mongoose.Schema(
  {
    board: { type: mongoose.Schema.Types.ObjectId, ref: 'Board', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    kind: { type: String, enum: ['manual', 'auto', 'restore'], default: 'manual' },
    graph: { type: graphSchema, required: true },
    graphHash: { type: String, default: null, select: true },
    revision: { type: Number, required: true },
    nodeCount: { type: Number, default: 0 },
    edgeCount: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
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

snapshotSchema.index({ board: 1, createdAt: -1 });

export const Snapshot = mongoose.model('Snapshot', snapshotSchema);
