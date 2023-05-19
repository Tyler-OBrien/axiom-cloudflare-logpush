// All Credit to https://gist.github.com/stefandanaita/88c4d8b187400d5b07524cd0a12843b2
// SPDX-License-Identifier: MIT-0

export interface Env {
  AuthSecret: string;
  LogPushSecret: string;
  Dataset: string;
  IngestRate: AnalyticsEngineDataset;
}
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    var url = new URL(request.url);
    if (request.headers.get("Authorization") !== env.LogPushSecret) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (!request.body) {
      return new Response("No Body", { status: 500 });
    }
    const events = request.body
      .pipeThrough(new DecompressionStream("gzip"))
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(readlineStream());

    let eventsToPush: string[] = [];
    for await (const event of streamAsyncIterator(events)) {
      // Do stuff with the event
      var parsedEvent = JSON.parse(event);
      // Trying to support most types. Most logpush events just have "Timestamp". Workers Logpush has "EventTimestampMs". HTTP has "EdgeStartTimestamp". Access Requests use CreatedAt. ZT Gateway Events use Datetime.
      parsedEvent["_time"] =
        parsedEvent.EventTimestampMs ??
        parsedEvent.Timestamp ??
        parsedEvent.EdgeStartTimestamp ??
        parsedEvent.CreatedAt ??
        parsedEvent.Datetime;
      eventsToPush.push(parsedEvent);
    }
    let json = JSON.stringify(eventsToPush);
    let dataset = url.pathname.substring(1);
    var response = await fetch(
      `https://api.axiom.co/v1/datasets/${dataset}/ingest`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.AuthSecret}`,
        },
        body: json,
      }
    );
    if (response.ok == false) {
      return new Response(`Axiom responded with: ${await response.text()}`, {
        status: 500,
      });
    }
    console.log(`Ingested ${eventsToPush.length} events into ${dataset}`);
    try {
      if (env.IngestRate) {
        env.IngestRate.writeDataPoint({
          blobs: [
            dataset,
            request.headers.get("internal-type") ?? "unknown", // If you are pushing more then one logpush datasets into the same Axiom dataset, you can use this to differentiate them.
          ],
          doubles: [eventsToPush.length],
          indexes: [dataset],
        });
      }
    } catch (exception) {
      console.error(
        `Error ingesting Analytics Engine events into ${dataset}: ${exception}`
      );
    }

    return new Response("Nom nom!", { status: 202 });
  },
};

async function* streamAsyncIterator(stream: ReadableStream) {
  // Get a lock on the stream
  const reader = stream.getReader();

  try {
    while (true) {
      // Read from the stream
      const { done, value } = await reader.read();

      // Exit if we're done
      if (done) {
        return;
      }

      // Else yield the chunk
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

interface ReadlineTransformerOptions {
  skipEmpty: boolean;
}

const defaultOptions: ReadlineTransformerOptions = {
  skipEmpty: true,
};

export class ReadlineTransformer implements Transformer {
  options: ReadlineTransformerOptions;
  lastString: string;
  separator: RegExp;

  public constructor(options?: ReadlineTransformerOptions) {
    this.options = { ...defaultOptions, ...options };
    this.lastString = "";
    this.separator = /[\r\n]+/;
  }

  public transform(
    chunk: string,
    controller: TransformStreamDefaultController<string>
  ) {
    // prepend with previous string (empty if none)
    const str = `${this.lastString}${chunk}`;
    // Extract lines from chunk
    const lines = str.split(this.separator);
    // Save last line as it might be incomplete
    this.lastString = (lines.pop() || "").trim();

    // eslint-disable-next-line no-restricted-syntax
    for (const line of lines) {
      const d = this.options.skipEmpty ? line.trim() : line;
      if (d.length > 0) controller.enqueue(d);
    }
  }

  public flush(controller: TransformStreamDefaultController<string>) {
    if (this.lastString.length > 0) controller.enqueue(this.lastString);
  }
}

export const readlineStream = () =>
  new TransformStream(new ReadlineTransformer());
