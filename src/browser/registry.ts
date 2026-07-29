import {
  BROWSER_MODEL_VERSION,
  entityIdKey,
  known,
  snapshotEntities,
  type BrowserDelta,
  type BrowserEntity,
  type BrowserEntityId,
  type BrowserSession,
  type BrowserSessionId,
  type BrowserSnapshot,
  type BrowserTabId,
  type EntityKind,
  type PrivateWindowPolicy,
  type StaleReason,
} from "./model.js";

export type EntityLookup =
  | Readonly<{ status: "active"; entity: BrowserEntity }>
  | Readonly<{ status: "stale"; stale: StaleEntity }>
  | Readonly<{ status: "missing"; id: BrowserEntityId }>;

export interface StaleEntity {
  readonly id: BrowserEntityId;
  readonly reason: StaleReason;
  readonly sequence: number;
  readonly observedAt: string;
  readonly replacementSessionId?: BrowserSessionId;
}

export class BrowserModelError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BrowserModelError";
  }
}

export class BrowserRegistry {
  readonly #active = new Map<string, BrowserEntity>();
  readonly #stale = new Map<string, StaleEntity>();
  #sequence = -1;
  #privateWindowPolicy: PrivateWindowPolicy | undefined;

  public constructor(snapshot?: BrowserSnapshot) {
    if (snapshot !== undefined) {
      this.loadInitialSnapshot(snapshot);
    }
  }

  public get sequence(): number {
    return this.#sequence;
  }

  public loadInitialSnapshot(snapshot: BrowserSnapshot): void {
    this.#assertSnapshot(snapshot);

    if (this.#sequence !== -1) {
      throw new BrowserModelError(
        "The initial browser snapshot has already been loaded.",
      );
    }

    this.#transact(() => {
      for (const entity of snapshotEntities(snapshot)) {
        this.#upsert(entity);
      }

      this.#privateWindowPolicy = snapshot.privateWindowPolicy;
      this.#sequence = snapshot.sequence;
    });
  }

  public reconcileAfterReconnect(snapshot: BrowserSnapshot): void {
    this.#assertSnapshot(snapshot);
    this.#assertNextSequence(snapshot.sequence);

    this.#transact(() => {
      const incoming = new Map(
        snapshotEntities(snapshot).map((entity) => [
          entityIdKey(entity.id),
          entity,
        ]),
      );
      const replacementSessions = this.#replacementSessions(snapshot.sessions);
      const replacementsByEntity = new Map(
        [...this.#active].map(([key, entity]) => [
          key,
          this.#replacementFor(entity, replacementSessions),
        ]),
      );

      for (const [key, entity] of this.#active) {
        if (incoming.has(key)) {
          continue;
        }

        const replacement = replacementsByEntity.get(key);
        this.#markStale(
          entity.id,
          replacement === undefined
            ? "missing-after-reconnect"
            : "session-replaced",
          snapshot.sequence,
          snapshot.capturedAt,
          replacement?.id,
        );
      }

      for (const entity of incoming.values()) {
        this.#upsert(entity);
      }

      this.#privateWindowPolicy = snapshot.privateWindowPolicy;
      this.#assertActiveReferences();
      this.#sequence = snapshot.sequence;
    });
  }

  public applyDelta(delta: BrowserDelta): void {
    this.#assertVersion(delta.schemaVersion);
    this.#assertNextSequence(delta.sequence);

    this.#transact(() => {
      for (const change of delta.changes) {
        switch (change.type) {
          case "entity.upserted":
            this.#upsert(change.entity);
            break;
          case "entity.removed":
            this.#removeWithDependents(
              change.id,
              change.reason,
              delta.sequence,
              delta.observedAt,
            );
            break;
          case "tab.crashed":
            this.#crashTab(change.id, delta.sequence, delta.observedAt);
            break;
          case "session.replaced":
            this.#replaceSession(
              change.previousSessionId,
              change.session,
              delta.sequence,
              delta.observedAt,
            );
            break;
        }
      }

      this.#assertPrivateWindowPolicy();
      this.#assertActiveReferences();
      this.#sequence = delta.sequence;
    });
  }

  public lookup(id: BrowserEntityId): EntityLookup {
    const key = entityIdKey(id);
    const entity = this.#active.get(key);

    if (entity !== undefined) {
      return { status: "active", entity };
    }

    const stale = this.#stale.get(key);

    if (stale !== undefined) {
      return { status: "stale", stale };
    }

    return { status: "missing", id };
  }

  public entities(kind?: EntityKind): readonly BrowserEntity[] {
    const entities = [...this.#active.values()];

    if (kind === undefined) {
      return entities;
    }

    return entities.filter((entity) => entity.kind === kind);
  }

  #assertSnapshot(snapshot: BrowserSnapshot): void {
    this.#assertVersion(snapshot.schemaVersion);

    if (snapshot.privateWindowPolicy === "hidden") {
      const privateOrUnverifiedWindow = snapshot.windows.find(
        (window) =>
          window.private.status !== "known" || window.private.value !== false,
      );

      if (privateOrUnverifiedWindow !== undefined) {
        throw new BrowserModelError(
          "A snapshot using the hidden private-window policy included a private or unverified window.",
        );
      }
    }

    const keys = new Set<string>();
    const entities = new Map<string, BrowserEntity>();

    for (const entity of snapshotEntities(snapshot)) {
      const key = entityIdKey(entity.id);

      if (keys.has(key)) {
        throw new BrowserModelError(
          `The snapshot contains duplicate identity ${JSON.stringify(key)}.`,
        );
      }

      keys.add(key);
      entities.set(key, entity);
    }

    for (const entity of entities.values()) {
      this.#assertEntityReferences(entity, entities);
    }

    this.#assertSingleSessionPerProfile(entities);
  }

  #transact(operation: () => void): void {
    const activeBefore = new Map(this.#active);
    const staleBefore = new Map(this.#stale);
    const sequenceBefore = this.#sequence;
    const privateWindowPolicyBefore = this.#privateWindowPolicy;

    try {
      operation();
    } catch (error) {
      this.#active.clear();
      this.#stale.clear();

      for (const entry of activeBefore) {
        this.#active.set(...entry);
      }

      for (const entry of staleBefore) {
        this.#stale.set(...entry);
      }

      this.#sequence = sequenceBefore;
      this.#privateWindowPolicy = privateWindowPolicyBefore;
      throw error;
    }
  }

  #assertPrivateWindowPolicy(): void {
    if (this.#privateWindowPolicy !== "hidden") {
      return;
    }

    const privateOrUnverifiedWindow = this.entities("window").find(
      (entity) =>
        entity.kind === "window" &&
        (entity.private.status !== "known" || entity.private.value !== false),
    );

    if (privateOrUnverifiedWindow !== undefined) {
      throw new BrowserModelError(
        "The hidden private-window policy excludes private or unverified windows.",
      );
    }
  }

  #assertActiveReferences(): void {
    for (const entity of this.#active.values()) {
      this.#assertEntityReferences(entity, this.#active);
    }

    this.#assertSingleSessionPerProfile(this.#active);
  }

  #assertSingleSessionPerProfile(
    entities: ReadonlyMap<string, BrowserEntity>,
  ): void {
    const profileKeys = new Set<string>();

    for (const entity of entities.values()) {
      if (entity.kind !== "session") {
        continue;
      }

      const profileKey = entityIdKey(entity.profileId);

      if (profileKeys.has(profileKey)) {
        throw new BrowserModelError(
          `Profile ${JSON.stringify(profileKey)} has more than one active browser session.`,
        );
      }

      profileKeys.add(profileKey);
    }
  }

  #assertEntityReferences(
    entity: BrowserEntity,
    entities: ReadonlyMap<string, BrowserEntity>,
  ): void {
    if (entity.kind !== entity.id.kind) {
      throw new BrowserModelError(
        `Entity kind ${entity.kind} does not match its identity kind ${entity.id.kind}.`,
      );
    }

    switch (entity.kind) {
      case "profile":
        return;
      case "session": {
        this.#requireReference(entity.profileId, "profile", entities);

        if (
          entityIdKey(entity.id.profileId) !== entityIdKey(entity.profileId)
        ) {
          throw new BrowserModelError(
            "A browser session identity must be scoped to its profile.",
          );
        }
        return;
      }
      case "window": {
        const session = this.#requireReference(
          entity.id.sessionId,
          "session",
          entities,
        );
        this.#requireReference(entity.profileId, "profile", entities);

        if (
          session.kind !== "session" ||
          entityIdKey(session.profileId) !== entityIdKey(entity.profileId)
        ) {
          throw new BrowserModelError(
            "A browser window must belong to its session's profile.",
          );
        }
        return;
      }
      case "space": {
        const window = this.#requireReference(
          entity.windowId,
          "window",
          entities,
        );
        this.#assertSameSession(entity, window);
        return;
      }
      case "tab": {
        const window = this.#requireReference(
          entity.windowId,
          "window",
          entities,
        );
        this.#assertSameSession(entity, window);

        if (
          entity.spaceId.status === "known" &&
          entity.spaceId.value !== null
        ) {
          const space = this.#requireReference(
            entity.spaceId.value,
            "space",
            entities,
          );
          this.#assertSameSession(entity, space);

          if (
            space.kind !== "space" ||
            entityIdKey(space.windowId) !== entityIdKey(entity.windowId)
          ) {
            throw new BrowserModelError(
              "A tab's Space must belong to the same browser window.",
            );
          }
        }

        if (
          entity.browsingContextId.status === "known" &&
          entity.browsingContextId.value !== null
        ) {
          const context = this.#requireReference(
            entity.browsingContextId.value,
            "browsing-context",
            entities,
          );

          if (
            context.kind !== "browsing-context" ||
            entityIdKey(context.tabId) !== entityIdKey(entity.id)
          ) {
            throw new BrowserModelError(
              "A tab's browsing context must refer back to that tab.",
            );
          }
        }
        return;
      }
      case "browsing-context": {
        const tab = this.#requireReference(entity.tabId, "tab", entities);
        this.#assertSameSession(entity, tab);

        if (
          entity.parentId.status === "known" &&
          entity.parentId.value !== null
        ) {
          const parent = this.#requireReference(
            entity.parentId.value,
            "browsing-context",
            entities,
          );
          this.#assertSameSession(entity, parent);

          if (
            parent.kind !== "browsing-context" ||
            entityIdKey(parent.tabId) !== entityIdKey(entity.tabId)
          ) {
            throw new BrowserModelError(
              "Parent and child browsing contexts must belong to the same tab.",
            );
          }
        }
        return;
      }
      case "frame": {
        const context = this.#requireReference(
          entity.browsingContextId,
          "browsing-context",
          entities,
        );
        this.#assertSameSession(entity, context);

        if (
          entity.parentFrameId.status === "known" &&
          entity.parentFrameId.value !== null
        ) {
          const parent = this.#requireReference(
            entity.parentFrameId.value,
            "frame",
            entities,
          );
          this.#assertSameSession(entity, parent);

          if (parent.kind === "frame") {
            const parentContext = this.#requireReference(
              parent.browsingContextId,
              "browsing-context",
              entities,
            );

            if (
              context.kind !== "browsing-context" ||
              parentContext.kind !== "browsing-context" ||
              entityIdKey(context.tabId) !== entityIdKey(parentContext.tabId)
            ) {
              throw new BrowserModelError(
                "Parent and child frames must belong to the same tab.",
              );
            }
          }
        }
        return;
      }
      case "element": {
        if (entity.id.snapshotSequence !== entity.snapshotSequence) {
          throw new BrowserModelError(
            "An element identity must use its originating snapshot sequence.",
          );
        }

        const tab = this.#requireReference(entity.tabId, "tab", entities);
        const frame = this.#requireReference(entity.frameId, "frame", entities);
        this.#assertSameSession(entity, tab);
        this.#assertSameSession(entity, frame);

        if (frame.kind === "frame") {
          const context = this.#requireReference(
            frame.browsingContextId,
            "browsing-context",
            entities,
          );

          if (
            tab.kind !== "tab" ||
            context.kind !== "browsing-context" ||
            entityIdKey(context.tabId) !== entityIdKey(tab.id)
          ) {
            throw new BrowserModelError(
              "An element's frame must belong to the same tab.",
            );
          }
        }
      }
    }
  }

  #requireReference(
    id: BrowserEntityId,
    expectedKind: EntityKind,
    entities: ReadonlyMap<string, BrowserEntity>,
  ): BrowserEntity {
    const referenced = entities.get(entityIdKey(id));

    if (referenced === undefined || referenced.kind !== expectedKind) {
      throw new BrowserModelError(
        `Missing ${expectedKind} reference ${JSON.stringify(entityIdKey(id))}.`,
      );
    }

    return referenced;
  }

  #assertSameSession(
    entity: Exclude<BrowserEntity, BrowserSession>,
    related: BrowserEntity,
  ): void {
    if (
      related.kind === "profile" ||
      related.kind === "session" ||
      entity.kind === "profile"
    ) {
      throw new BrowserModelError(
        "Session-scoped entities must not use an unscoped relationship.",
      );
    }

    if (
      entityIdKey(entity.id.sessionId) !== entityIdKey(related.id.sessionId)
    ) {
      throw new BrowserModelError(
        "Related browser entities must belong to the same session.",
      );
    }
  }

  #assertVersion(version: number): void {
    if (version !== BROWSER_MODEL_VERSION) {
      throw new BrowserModelError(
        `Unsupported browser model version ${String(version)}.`,
      );
    }
  }

  #assertNextSequence(sequence: number): void {
    if (sequence <= this.#sequence) {
      throw new BrowserModelError(
        `Browser update sequence ${String(sequence)} is not newer than ${String(this.#sequence)}.`,
      );
    }
  }

  #upsert(entity: BrowserEntity): void {
    const key = entityIdKey(entity.id);

    if (this.#stale.has(key)) {
      throw new BrowserModelError(
        `The transport attempted to reuse stale identity ${JSON.stringify(key)}.`,
      );
    }

    this.#active.set(key, entity);
  }

  #removeWithDependents(
    id: BrowserEntityId,
    reason: StaleReason,
    sequence: number,
    observedAt: string,
    replacementSessionId?: BrowserSessionId,
  ): void {
    const target = this.#active.get(entityIdKey(id));

    if (target === undefined) {
      return;
    }

    const removals = new Set<string>([entityIdKey(id)]);
    let changed = true;

    while (changed) {
      changed = false;

      for (const [key, candidate] of this.#active) {
        if (
          !removals.has(key) &&
          [...removals].some((removedKey) => {
            const removed = this.#active.get(removedKey);
            return (
              removed !== undefined &&
              this.#directlyDependsOn(candidate, removed.id)
            );
          })
        ) {
          removals.add(key);
          changed = true;
        }
      }
    }

    for (const key of removals) {
      const entity = this.#active.get(key);

      if (entity !== undefined) {
        this.#markStale(
          entity.id,
          reason,
          sequence,
          observedAt,
          replacementSessionId,
        );
      }
    }
  }

  #markStale(
    id: BrowserEntityId,
    reason: StaleReason,
    sequence: number,
    observedAt: string,
    replacementSessionId?: BrowserSessionId,
  ): void {
    const key = entityIdKey(id);
    this.#active.delete(key);
    this.#stale.set(key, {
      id,
      reason,
      sequence,
      observedAt,
      ...(replacementSessionId === undefined ? {} : { replacementSessionId }),
    });
  }

  #crashTab(id: BrowserTabId, sequence: number, observedAt: string): void {
    const entity = this.#active.get(entityIdKey(id));

    if (entity === undefined || entity.kind !== "tab") {
      throw new BrowserModelError("Cannot crash a tab that is not active.");
    }

    this.#active.set(entityIdKey(id), {
      ...entity,
      browsingContextId: known(null),
      lifecycleState: "crashed",
    });

    const pageScopedEntities = [...this.#active.values()].filter((candidate) =>
      this.#isPageScopedToTab(candidate, id),
    );

    for (const candidate of pageScopedEntities) {
      this.#markStale(candidate.id, "crashed", sequence, observedAt);
    }
  }

  #replaceSession(
    previousSessionId: BrowserSessionId,
    session: BrowserSession,
    sequence: number,
    observedAt: string,
  ): void {
    if (entityIdKey(previousSessionId) === entityIdKey(session.id)) {
      throw new BrowserModelError(
        "A replacement browser session must have a new transport identity.",
      );
    }

    this.#removeWithDependents(
      previousSessionId,
      "session-replaced",
      sequence,
      observedAt,
      session.id,
    );
    this.#upsert(session);
  }

  #replacementSessions(
    incomingSessions: readonly BrowserSession[],
  ): ReadonlyMap<string, BrowserSession> {
    const currentSessionKeys = new Set(
      this.entities("session").map((entity) => entityIdKey(entity.id)),
    );
    const replacements = new Map<string, BrowserSession>();

    for (const session of incomingSessions) {
      if (!currentSessionKeys.has(entityIdKey(session.id))) {
        replacements.set(entityIdKey(session.profileId), session);
      }
    }

    return replacements;
  }

  #replacementFor(
    entity: BrowserEntity,
    replacements: ReadonlyMap<string, BrowserSession>,
  ): BrowserSession | undefined {
    if (entity.kind === "profile") {
      return undefined;
    }

    if (entity.kind === "session") {
      return replacements.get(entityIdKey(entity.profileId));
    }

    const session = this.#active.get(entityIdKey(entity.id.sessionId));

    if (session === undefined || session.kind !== "session") {
      return undefined;
    }

    return replacements.get(entityIdKey(session.profileId));
  }

  #directlyDependsOn(
    entity: BrowserEntity,
    possibleParentId: BrowserEntityId,
  ): boolean {
    if (entity.kind === "profile") {
      return false;
    }

    if (entity.kind === "session") {
      return (
        possibleParentId.kind === "profile" &&
        entityIdKey(entity.profileId) === entityIdKey(possibleParentId)
      );
    }

    if (
      possibleParentId.kind === "session" &&
      entityIdKey(entity.id.sessionId) === entityIdKey(possibleParentId)
    ) {
      return true;
    }

    switch (entity.kind) {
      case "window":
        return (
          possibleParentId.kind === "profile" &&
          entityIdKey(entity.profileId) === entityIdKey(possibleParentId)
        );
      case "space":
        return (
          possibleParentId.kind === "window" &&
          entityIdKey(entity.windowId) === entityIdKey(possibleParentId)
        );
      case "tab":
        return (
          (possibleParentId.kind === "window" &&
            entityIdKey(entity.windowId) === entityIdKey(possibleParentId)) ||
          (possibleParentId.kind === "space" &&
            entity.spaceId.status === "known" &&
            entity.spaceId.value !== null &&
            entityIdKey(entity.spaceId.value) === entityIdKey(possibleParentId))
        );
      case "browsing-context":
        return (
          (possibleParentId.kind === "tab" &&
            entityIdKey(entity.tabId) === entityIdKey(possibleParentId)) ||
          (possibleParentId.kind === "browsing-context" &&
            entity.parentId.status === "known" &&
            entity.parentId.value !== null &&
            entityIdKey(entity.parentId.value) ===
              entityIdKey(possibleParentId))
        );
      case "frame":
        return (
          (possibleParentId.kind === "browsing-context" &&
            entityIdKey(entity.browsingContextId) ===
              entityIdKey(possibleParentId)) ||
          (possibleParentId.kind === "frame" &&
            entity.parentFrameId.status === "known" &&
            entity.parentFrameId.value !== null &&
            entityIdKey(entity.parentFrameId.value) ===
              entityIdKey(possibleParentId))
        );
      case "element":
        return (
          (possibleParentId.kind === "tab" &&
            entityIdKey(entity.tabId) === entityIdKey(possibleParentId)) ||
          (possibleParentId.kind === "frame" &&
            entityIdKey(entity.frameId) === entityIdKey(possibleParentId))
        );
    }
  }

  #isPageScopedToTab(entity: BrowserEntity, tabId: BrowserTabId): boolean {
    switch (entity.kind) {
      case "browsing-context":
      case "element":
        return entityIdKey(entity.tabId) === entityIdKey(tabId);
      case "frame": {
        const context = this.#active.get(entityIdKey(entity.browsingContextId));
        return (
          context !== undefined &&
          context.kind === "browsing-context" &&
          entityIdKey(context.tabId) === entityIdKey(tabId)
        );
      }
      default:
        return false;
    }
  }
}
