import { ZodError } from 'zod';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ApiError } from '../utils/ApiError.js';

export function notFoundHandler(req, _res, next) {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(error, req, res, _next) {
  let statusCode = error.statusCode ?? 500;
  let message = error.message ?? 'Something went wrong';
  let code = error.code;
  let details = error.details;

  if (error instanceof ZodError) {
    statusCode = 400;
    message = 'Validation failed';
    code = 'BAD_REQUEST';
    details = error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
  } else if (error instanceof mongoose.Error.ValidationError) {
    statusCode = 400;
    code = 'VALIDATION_ERROR';
    details = Object.values(error.errors).map((entry) => ({ path: entry.path, message: entry.message }));
  } else if (error instanceof mongoose.Error.CastError) {
    statusCode = 400;
    message = `Invalid value for ${error.path}`;
    code = 'BAD_REQUEST';
  } else if (error?.code === 11000) {
    statusCode = 409;
    message = 'That record already exists';
    code = 'DUPLICATE_KEY';
    details = error.keyValue;
  } else if (error?.type === 'entity.too.large') {
    statusCode = 413;
    message = 'Request payload is too large';
    code = 'PAYLOAD_TOO_LARGE';
  }

  if (statusCode >= 500) {
    logger.error({ err: error, path: req.originalUrl, method: req.method }, 'Unhandled request error');
    if (env.isProduction && !(error instanceof ApiError)) {
      message = 'Internal server error';
      details = undefined;
    }
  }

  res.status(statusCode).json({
    error: {
      message,
      code: code ?? 'ERROR',
      ...(details ? { details } : {}),
    },
  });
}
