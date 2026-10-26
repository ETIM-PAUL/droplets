import { expect, it } from "vitest";
import { name } from "./index";

it("exports its package name", () => {
  expect(name).toBe("@railkit/adapters");
});
