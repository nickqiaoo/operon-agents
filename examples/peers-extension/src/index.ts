import { createFilePeerRepo, createMemoryPeerRepo, peers, sharedLabelVisibility } from "operon-agents-peers";

// Session restoration comes from ExtensionHost, supplied by the embedding application.
export default peers({
  repo: ({ dataDir }) => dataDir !== undefined ? createFilePeerRepo(dataDir) : createMemoryPeerRepo(),
  visibility: sharedLabelVisibility,
  teammates: { member: { title: "teammate" } },
});
