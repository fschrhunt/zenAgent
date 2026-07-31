/**
 * Parent-process half of Zen Agent's page actor.
 *
 * The privileged experiment API obtains an actor from an explicit
 * WindowGlobal. No method here activates a BrowsingContext.
 */
export class ZenAgentPageParent extends JSWindowActorParent {
  async #pageQuery(name, options) {
    const outcome = await this.sendQuery(name, options);

    if (outcome?.ok !== true) {
      throw Object.assign(
        new Error(outcome?.error?.message ?? "Page actor failure."),
        { code: outcome?.error?.code ?? "internal" },
      );
    }

    return outcome.value;
  }

  inspect(options) {
    return this.#pageQuery("ZenAgentPage:Inspect", options);
  }

  documentInfo() {
    return this.#pageQuery("ZenAgentPage:Document", {});
  }

  snapshot(options) {
    return this.#pageQuery("ZenAgentPage:Snapshot", options);
  }

  query(options) {
    return this.#pageQuery("ZenAgentPage:Query", options);
  }

  mutate(options) {
    return this.#pageQuery("ZenAgentPage:Mutate", options);
  }

  media(options) {
    return this.#pageQuery("ZenAgentPage:Media", options);
  }

  resource(options) {
    return this.#pageQuery("ZenAgentPage:Resource", options);
  }

  mediaResource(options) {
    return this.#pageQuery("ZenAgentPage:MediaResource", options);
  }

  screenshotRect(options) {
    return this.#pageQuery("ZenAgentPage:ScreenshotRect", options);
  }
}
