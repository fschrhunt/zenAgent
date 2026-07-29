/**
 * Parent-process half of Zen Agent's bounded page-inspection actor.
 *
 * The privileged experiment API obtains this actor from the explicit tab's
 * current WindowGlobal. It never activates a browsing context.
 */
export class ZenAgentPageParent extends JSWindowActorParent {
  inspect(options) {
    return this.sendQuery("ZenAgentPage:Inspect", options);
  }
}
