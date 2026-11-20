import { Schema } from 'mongoose';
import { EDGE_KINDS, NODE_TYPES } from '../utils/constants.js';

export const nodeSchema = new Schema(
  {
    id: { type: String, required: true, trim: true, maxlength: 64 },
    type: { type: String, required: true, enum: NODE_TYPES },
    label: { type: String, required: true, trim: true, maxlength: 80 },
    x: { type: Number, required: true },
    y: { type: Number, required: true },
    width: { type: Number, default: 208, min: 60, max: 600 },
    height: { type: Number, default: 96, min: 40, max: 400 },
    description: { type: String, default: '', maxlength: 500 },
    entities: { type: [String], default: [] },
    // One Yjs binary update for this sticky note. Other nodes use null.
    stickyUpdate: { type: Buffer, default: null },
  },
  { _id: false },
);

export const edgeSchema = new Schema(
  {
    id: { type: String, required: true, trim: true, maxlength: 64 },
    from: { type: String, required: true, maxlength: 64 },
    to: { type: String, required: true, maxlength: 64 },
    label: { type: String, default: '', maxlength: 80 },
    kind: { type: String, enum: EDGE_KINDS, default: 'sync' },
    description: { type: String, default: '', maxlength: 500 },
  },
  { _id: false },
);

export const graphSchema = new Schema(
  {
    nodes: {
      type: [nodeSchema],
      default: [],
      validate: {
        validator: (nodes) => nodes.length <= 400,
        message: 'A board can contain at most 400 nodes',
      },
    },
    edges: {
      type: [edgeSchema],
      default: [],
      validate: {
        validator: (edges) => edges.length <= 800,
        message: 'A board can contain at most 800 connections',
      },
    },
  },
  { _id: false },
);
