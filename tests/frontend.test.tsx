// @vitest-environment jsdom
import { it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import App from "../src/App";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(fail = false) {
  const s = {
    id: "service",
    name: "Discovery consultation",
    duration: 30,
    price: 3500,
    description: "A focused consultation.",
    active: true,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input.includes("/session"))
        return Response.json({
          csrf: "test",
          admin: false,
          timezone: "Europe/London",
          today: "2026-09-14",
        });
      if (input.includes("/catalog"))
        return Response.json({
          services: [s],
          staff: [
            {
              id: "staff",
              name: "Alex Test",
              bio: "Consultations",
              active: true,
              services: ["service"],
            },
          ],
          hours: [],
        });
      if (input.includes("/availability"))
        return fail
          ? Response.json(
              { error: { message: "Availability temporarily unavailable." } },
              { status: 503 },
            )
          : Response.json({ slots: [] });
      if (input.includes("/appointments"))
        return Response.json({ appointments: [] });
      return Response.json({});
    }),
  );
}
it("loads real service data and explains the demo scope", async () => {
  setup();
  render(<App />);
  expect(
    await screen.findByRole("heading", { name: "Book an appointment" }),
  ).toBeInTheDocument();
  expect(screen.getAllByText("Discovery consultation").length).toBeGreaterThan(
    0,
  );
  expect(screen.getByText(/A real booking system/)).toBeInTheDocument();
});
it("does not allow continuing without a selected live slot", async () => {
  setup();
  render(<App />);
  await screen.findByRole("heading", { name: "Book an appointment" });
  expect(
    screen.getByRole("button", { name: "Continue to details" }),
  ).toBeDisabled();
  await screen.findByText("A little more space on another day");
});
it("shows an actionable error instead of inventing available times", async () => {
  setup(true);
  render(<App />);
  expect(
    await screen.findByText("Availability temporarily unavailable."),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
});
it("restores the appointments view from the backend", async () => {
  setup();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  render(<App />);
  await screen.findByRole("heading", { name: "Book an appointment" });
  fireEvent.click(screen.getByRole("button", { name: "My appointments" }));
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "Your appointments" }),
    ).toBeInTheDocument(),
  );
  expect(
    await screen.findByText("Your next appointment starts here"),
  ).toBeInTheDocument();
});
