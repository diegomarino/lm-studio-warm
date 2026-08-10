import { describe, it, expect } from "vitest"
import factory from "../src/index"

describe("scaffold", () => {
  it("exports a default extension factory", () => {
    expect(typeof factory).toBe("function")
  })
})
