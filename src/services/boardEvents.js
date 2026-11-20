import { EventEmitter } from 'node:events';
import { getRedisClient } from '../config/redis.js';

/**
 * Decouples REST controllers from the Socket.IO layer: services emit domain
 * events, the realtime layer broadcasts them to the affected board room.
 */
export const boardEvents = new EventEmitter();
boardEvents.setMaxListeners(50);

const BOARD_EVENTS_CHANNEL = 'archflow:board-events';
let redisSubscribed = false;
let boardEventSubscriber;

export async function connectBoardEvents() {
  if (process.env.DISABLE_SOCKET_REDIS_ADAPTER === 'true') return;
  if (redisSubscribed) return;
  const redis = getRedisClient();
  boardEventSubscriber = redis.duplicate();
  boardEventSubscriber.on('error', (error) => {
    if (error?.message !== 'The client is closed') {
      boardEvents.emit('error', error);
    }
  });
  await boardEventSubscriber.connect();
  await boardEventSubscriber.subscribe(BOARD_EVENTS_CHANNEL, (message) => {
    try {
      const event = JSON.parse(message);
      boardEvents.emit(event.type, event.payload);
    } catch (error) {
      boardEvents.emit('error', error);
    }
  });
  redisSubscribed = true;
}

export async function publishBoardEvent(type, payload) {
  // Single-process mode has no Redis subscriber, so deliver events locally.
  if (process.env.DISABLE_SOCKET_REDIS_ADAPTER === 'true') {
    boardEvents.emit(type, payload);
    return;
  }

  try {
    await getRedisClient().publish(
      BOARD_EVENTS_CHANNEL,
      JSON.stringify({ type, payload }),
    );
  } catch {
    // The in-process listener still works when Redis is unavailable.
    boardEvents.emit(type, payload);
  }
}

export async function disconnectBoardEvents() {
  if (boardEventSubscriber?.isOpen) {
    await Promise.allSettled([boardEventSubscriber.disconnect()]);
  }
  boardEventSubscriber = undefined;
  redisSubscribed = false;
}
