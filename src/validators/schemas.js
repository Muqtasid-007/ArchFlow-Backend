import { z } from 'zod';
import { EDGE_KINDS, NODE_TYPES, ROLES } from '../utils/constants.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid identifier');
const commentText = z.string().trim().min(1, 'Comment text cannot be empty').max(5000);

export const commentAnchorSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('canvas'),
    x: z.number().finite().min(-10_000_000).max(10_000_000),
    y: z.number().finite().min(-10_000_000).max(10_000_000),
  }).strict(),
  z.object({
    type: z.literal('node'),
    nodeId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    offsetX: z.number().finite().min(-10_000_000).max(10_000_000),
    offsetY: z.number().finite().min(-10_000_000).max(10_000_000),
  }).strict(),
]);

export const createCommentSchema = z.object({ anchor: commentAnchorSchema, text: commentText }).strict();
export const replyCommentSchema = z.object({ text: commentText }).strict();
export const commentThreadListSchema = z.object({
  state: z.enum(['open', 'resolved']).optional().default('open'),
  cursor: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
}).strict();
export const commentRepliesSchema = z.object({
  cursor: objectId.optional(),
}).strict();
export const commentCreateEventSchema = z.object({
  boardId: objectId,
  anchor: commentAnchorSchema,
  text: commentText,
}).strict();
export const commentReplyEventSchema = z.object({
  boardId: objectId,
  threadId: objectId,
  text: commentText,
}).strict();
export const commentEditEventSchema = z.object({
  boardId: objectId,
  commentId: objectId,
  text: commentText,
}).strict();
export const commentThreadEventSchema = z.object({
  boardId: objectId,
  threadId: objectId,
}).strict();
export const commentDeleteEventSchema = z.object({
  boardId: objectId,
  commentId: objectId,
}).strict();

const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[A-Za-z]/, 'Password must include a letter')
  .regex(/\d/, 'Password must include a number');

export const registerSchema = z
  .object({
    name: z.string().trim().min(2).max(60),
    email: z.string().trim().toLowerCase().email('Enter a valid email address').max(160),
    password,
  })
  .strict();

export const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().email('Enter a valid email address'),
    password: z.string().min(1, 'Password is required'),
  })
  .strict();

export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(2).max(60).optional(),
    avatarColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .optional(),
  })
  .strict();

export const createBoardSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(300).optional().default(''),
  })
  .strict();

export const updateBoardSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    description: z.string().trim().max(300).optional(),
    archived: z.boolean().optional(),
  })
  .strict();

export const inviteMemberSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    role: z.enum(ROLES).default('editor'),
  })
  .strict();

export const updateMemberSchema = z.object({ role: z.enum(ROLES) }).strict();

export const createSnapshotSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    kind: z.enum(['manual', 'auto']).optional().default('manual'),
  })
  .strict();

const nodeId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Invalid node id');

// Fields without defaults, reused for partial updates so a PATCH never resets
// values the client did not send.
const nodeFields = {
  type: z.enum(NODE_TYPES),
  label: z.string().trim().min(1).max(80),
  x: z.number().finite().min(-100000).max(100000),
  y: z.number().finite().min(-100000).max(100000),
  width: z.number().finite().min(60).max(600),
  height: z.number().finite().min(40).max(400),
  description: z.string().max(500),
  entities: z.array(z.string().trim().min(1).max(40)).max(10),
};

export const nodeSchema = z.object({
  id: nodeId,
  ...nodeFields,
  width: nodeFields.width.default(208),
  height: nodeFields.height.default(96),
  description: nodeFields.description.default(''),
  entities: nodeFields.entities.default([]),
});

const edgeFields = {
  from: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  to: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  label: z.string().trim().max(80),
  kind: z.enum(EDGE_KINDS),
  description: z.string().max(500),
};

export const edgeSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Invalid connection id'),
    ...edgeFields,
    label: edgeFields.label.default(''),
    kind: edgeFields.kind.default('sync'),
    description: edgeFields.description.default(''),
  })
  .refine((edge) => edge.from !== edge.to, {
    message: 'A component cannot connect to itself',
    path: ['to'],
  });

export const graphSchema = z.object({
  nodes: z.array(nodeSchema).max(400),
  edges: z.array(edgeSchema).max(800),
});

export const nodePatchSchema = z
  .object(nodeFields)
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Patch cannot be empty' });

export const edgePatchSchema = z
  .object(edgeFields)
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Patch cannot be empty' })
  .refine((patch) => patch.from === undefined || patch.to === undefined || patch.from !== patch.to, {
    message: 'A component cannot connect to itself',
    path: ['to'],
  });

export const canvasOpSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('node.create'), node: nodeSchema }),
  z.object({ type: z.literal('node.update'), nodeId: z.string().max(64), patch: nodePatchSchema }),
  z.object({ type: z.literal('node.delete'), nodeId: z.string().max(64) }),
  z.object({ type: z.literal('edge.create'), edge: edgeSchema }),
  z.object({ type: z.literal('edge.update'), edgeId: z.string().max(64), patch: edgePatchSchema }),
  z.object({ type: z.literal('edge.delete'), edgeId: z.string().max(64) }),
]);

export const canvasMessageSchema = z
  .object({
    opId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/, 'Invalid operation id'),
    baseRevision: z.number().int().min(1),
    op: canvasOpSchema,
  })
  .strict();

export const boardIdParamSchema = z.object({ boardId: objectId });
export const memberParamSchema = z.object({ boardId: objectId, userId: objectId });
export const snapshotParamSchema = z.object({ boardId: objectId, snapshotId: objectId });
