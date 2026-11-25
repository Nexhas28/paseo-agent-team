import { describe, expect, it } from "vitest";
import { closedIdsOf, reconnectChoices } from "../client/screen-logic";

describe("reconnectChoices", () => {
  const workspaces = [
    { id: "w1", title: "orchestrator" },
    { id: "w2", title: "Docs" },
    { id: "w3", title: "spare" },
    { id: "w4", title: "review" },
  ];
  const lost = { file: "lost.json", workspaceId: null, sharedWorkspaces: ["docs"] };
  const other = { file: "other.json", workspaceId: "w1", sharedWorkspaces: [" Review "] };

  it("offers the team's own shared workspace and unused ones, not another team's home or shared workspace", () => {
    expect(reconnectChoices(workspaces, [lost, other], lost).map((workspace) => workspace.id)).toEqual(["w2", "w3"]);
  });

  it("offers a shared workspace even when no unused workspace exists", () => {
    expect(reconnectChoices([workspaces[0]!, workspaces[1]!], [lost, other], lost).map((workspace) => workspace.id)).toEqual(["w2"]);
  });

  it("keeps another team's shared workspace out for every other team", () => {
    const second = { file: "second.json", workspaceId: null, sharedWorkspaces: [] };
    expect(reconnectChoices(workspaces, [lost, other, second], second).map((workspace) => workspace.id)).toEqual(["w3"]);
  });

  it("offers everything when the project has no other team", () => {
    expect(reconnectChoices(workspaces, [lost], lost)).toEqual(workspaces);
  });
});

describe("closedIdsOf", () => {
  it("collects the ids of the listed projects once each", () => {
    expect(closedIdsOf(["p1", "p2"], { p1: ["a", "b"], p2: ["b", "c"] })).toEqual(["a", "b", "c"]);
  });

  it("leaves out a project that is no longer listed or never reported", () => {
    expect(closedIdsOf(["p2", "p3"], { p1: ["a"], p2: ["c"] })).toEqual(["c"]);
    expect(closedIdsOf([], { p1: ["a"] })).toEqual([]);
  });
});
