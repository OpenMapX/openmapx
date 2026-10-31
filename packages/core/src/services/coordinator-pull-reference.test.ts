import { expect, it } from "vitest";
import { coordinatorPullReferenceIdentity as identity } from "./coordinator-pull-reference";

it.each([
  ["example/coordinator:main", "docker.io/example/coordinator:main"],
  ["ubuntu", "index.docker.io/library/ubuntu:latest"],
  ["docker.io/ubuntu", "ubuntu:latest"],
  ["ubuntu:Tag", "docker.io/library/ubuntu:Tag"],
  [`ubuntu:ignored@sha256:${"a".repeat(64)}`, `docker.io/library/ubuntu@sha256:${"a".repeat(64)}`],
])("normalizes Docker aliases %s", (a, b) => expect(identity(a)).toBe(identity(b)));
it("keeps tags, case, explicit ports and digest identities distinct", () => {
  expect(identity("ubuntu:main")).not.toBe(identity("ubuntu:other"));
  expect(identity("ubuntu:Tag")).not.toBe(identity("ubuntu:tag"));
  expect(identity("localhost:5000/ubuntu")).not.toBe(identity("localhost/ubuntu"));
  expect(identity("ubuntu")).not.toBe(identity(`ubuntu@sha256:${"a".repeat(64)}`));
});
it.each([
  "example//repo",
  "example/../repo",
  "ubuntu:-bad",
  "https://docker.io/ubuntu",
  "UPPER/repo",
  "a".repeat(64),
  "ubuntu@sha512:abcd",
  "ubuntu:tag:twice",
])("refuses unsupported normalization %s", (value) => expect(() => identity(value)).toThrow());
