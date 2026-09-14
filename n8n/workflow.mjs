// Private deployment supplies credential IDs and manager chat ID. No secrets in source.
export function bookingWorkflow({
  headerCredential,
  telegramCredential,
  chatId,
}) {
  const header = {
    id: headerCredential,
    name: "Booking automation authentication",
  };
  const http = (name, path, jsonBody, position) => ({
    id: crypto.randomUUID(),
    name,
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position,
    parameters: {
      method: "POST",
      url: "http://api:4300/api/automation/" + path,
      authentication: "genericCredentialType",
      genericAuthType: "httpHeaderAuth",
      sendBody: true,
      specifyBody: "json",
      jsonBody,
      options: { timeout: 8000 },
    },
    credentials: { httpHeaderAuth: header },
  });
  const nodes = [
    {
      id: crypto.randomUUID(),
      name: "Appointment event",
      type: "n8n-nodes-base.webhook",
      typeVersion: 2,
      position: [0, 0],
      webhookId: "northline-booking",
      parameters: {
        httpMethod: "POST",
        path: "northline-booking",
        authentication: "headerAuth",
        responseMode: "onReceived",
        options: {},
      },
      credentials: { httpHeaderAuth: header },
    },
    {
      id: crypto.randomUUID(),
      name: "Every minute",
      type: "n8n-nodes-base.scheduleTrigger",
      typeVersion: 1.2,
      position: [0, 220],
      parameters: {
        rule: { interval: [{ field: "minutes", minutesInterval: 1 }] },
      },
    },
    http(
      "Schedule reminders and recover queued events",
      "due",
      "{}",
      [230, 220],
    ),
    http(
      "Validate and claim event",
      "claim",
      "={{ JSON.stringify({eventId: $json.body?.eventId || $json.eventId}) }}",
      [480, 0],
    ),
    {
      id: crypto.randomUUID(),
      name: "Send only claimed events",
      type: "n8n-nodes-base.if",
      typeVersion: 2.2,
      position: [720, 0],
      parameters: {
        conditions: {
          options: {
            caseSensitive: true,
            leftValue: "",
            typeValidation: "strict",
            version: 2,
          },
          conditions: [
            {
              id: crypto.randomUUID(),
              leftValue: "={{ $json.claimed }}",
              rightValue: true,
              operator: {
                type: "boolean",
                operation: "true",
                singleValue: true,
              },
            },
          ],
          combinator: "and",
        },
        options: {},
      },
    },
    {
      id: crypto.randomUUID(),
      name: "Telegram demo delivery",
      type: "n8n-nodes-base.telegram",
      typeVersion: 1.2,
      position: [960, -80],
      parameters: {
        chatId,
        text: "={{ $json.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }}",
        additionalFields: {
          appendAttribution: false,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        },
      },
      credentials: {
        telegramApi: {
          id: telegramCredential,
          name: "Booking manager Telegram",
        },
      },
      onError: "continueRegularOutput",
    },
    http(
      "Record confirmed receipt",
      "complete",
      "={{ JSON.stringify({eventId: $('Validate and claim event').item.json.eventId, claim: $('Validate and claim event').item.json.claim, delivered: Boolean($json.message_id || $json.result?.message_id), messageId: ($json.message_id || $json.result?.message_id) ? String($json.message_id || $json.result?.message_id) : null}) }}",
      [1200, -80],
    ),
  ];
  nodes[6].retryOnFail = true;
  nodes[6].maxTries = 3;
  nodes[6].waitBetweenTries = 1000;
  const connections = {};
  const connect = (from, to) => {
    connections[from] = { main: [[{ node: to, type: "main", index: 0 }]] };
  };
  connect("Appointment event", "Validate and claim event");
  connect("Every minute", "Schedule reminders and recover queued events");
  connect(
    "Schedule reminders and recover queued events",
    "Validate and claim event",
  );
  connect("Validate and claim event", "Send only claimed events");
  connections["Send only claimed events"] = {
    main: [[{ node: "Telegram demo delivery", type: "main", index: 0 }], []],
  };
  connect("Telegram demo delivery", "Record confirmed receipt");
  return {
    id: "northlineBookingDemo",
    name: "Northline Booking · events, scheduled reminders & Telegram",
    nodes,
    connections,
    settings: {
      executionOrder: "v1",
      timezone: "Europe/London",
      saveDataErrorExecution: "none",
      saveDataSuccessExecution: "none",
      saveManualExecutions: false,
      executionTimeout: 40,
    },
  };
}
