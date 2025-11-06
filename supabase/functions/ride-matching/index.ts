import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { MongoClient, ObjectId } from "https://deno.land/x/mongo@v0.32.0/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const MONGODB_URI = Deno.env.get("MONGODB_CONNECTION_URL");
let client: MongoClient | null = null;
let useInMemory = false;
const localRides: any[] = [];

function getInMemoryCollection() {
  return {
    insertOne: async (doc: any) => {
      const id = (Math.random() * 1e16).toString(36);
      const newDoc = { ...doc, id };
      localRides.push(newDoc);
      return id;
    },
    find: (query: any) => {
      // very simple filter supporting equality on top-level keys
      const results = localRides.filter((r) => {
        for (const k of Object.keys(query || {})) {
          if (r[k] !== query[k]) return false;
        }
        return true;
      });
      return {
        toArray: async () => results,
        sort: () => ({ toArray: async () => results }),
      } as any;
    },
    updateOne: async (filter: any, update: any) => {
      // support filter by _id or id
      const id = filter?._id?.toString?.() ?? filter?.id ?? filter?._id ?? null;
      const idx = localRides.findIndex((r) => r.id === id || r._id?.toString?.() === id);
      if (idx === -1) return { modifiedCount: 0 };
      const set = update?.$set ?? {};
      localRides[idx] = { ...localRides[idx], ...set };
      return { modifiedCount: 1 };
    },
  };
}

async function getMongoClient() {
  if (!MONGODB_URI) {
    // For local dev allow in-memory fallback instead of throwing so frontend can function without a DB
    useInMemory = true;
    return null;
  }

  if (!client) {
    client = new MongoClient();
    // connect returns a Promise; ensure a meaningful error if URI is invalid
    await client.connect(MONGODB_URI);
  }
  return client;
}

// Normalize various possible ride payload shapes (snake_case vs camelCase)
function normalizeRideInput(input: Record<string, any>) {
  if (!input) return {};
  return {
    rideName: input.rideName ?? input.ride_name ?? input.name ?? null,
    pickup: input.pickup ?? input.pickup_location ?? input.from_location ?? null,
    dropoff: input.dropoff ?? input.dropoff_location ?? input.to_location ?? null,
    time: input.time ?? input.ride_date ?? input.scheduled_date ?? input.date ?? null,
    type: input.type ?? input.ride_type ?? input.mode ?? null,
    estimatedFare: input.estimatedFare ?? input.fare_estimate ?? input.fare ?? null,
    driverName: input.driverName ?? input.driver_name ?? null,
    vehicle: input.vehicle ?? input.vehicle_details ?? null,
    seats: input.seats ?? input.seats_available ?? null,
    location:
      input.location ??
      (input.location_lat && input.location_lng
        ? `${input.location_lat}, ${input.location_lng}`
        : input.coords ?? null),
    // keep any other fields as-is so additional properties aren't lost
    ...input,
  };
}

function mapDbRideToResponse(r: Record<string, any>) {
  // Accept DB documents in various shapes (snake_case from some components or camelCase)
  return {
    id: r.id ?? r._id?.toString?.() ?? r._id ?? r._id?.$oid ?? null,
    rideName: r.rideName ?? r.ride_name ?? r.name ?? null,
    pickup: r.pickup ?? r.pickup_location ?? r.from_location ?? null,
    dropoff: r.dropoff ?? r.dropoff_location ?? r.to_location ?? null,
    time: r.time ?? r.ride_date ?? r.scheduled_date ?? r.date ?? null,
    type: r.type ?? r.ride_type ?? null,
    estimatedFare: r.estimatedFare ?? r.fare_estimate ?? r.fare ?? null,
    driverName: r.driverName ?? r.driver_name ?? null,
    vehicle: r.vehicle ?? r.vehicle_details ?? null,
    seats: r.seats ?? r.seats_available ?? null,
    status: r.status ?? null,
    userId: r.userId ?? r.user_id ?? null,
    createdAt: r.createdAt ?? r.created_at ?? null,
    updatedAt: r.updatedAt ?? r.updated_at ?? null,
    // include raw DB doc for advanced clients if needed
    __raw: r,
  };
}

serve(async (req: Request) => {
  // Handle preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 🩺 Health check endpoint
    if (req.method === "GET") {
      return new Response(
        JSON.stringify({ status: "ok", message: "Ride-matching function is live 🚀" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 🧾 Safely parse JSON body (avoid "Unexpected end of JSON input")
    let body = {};
    try {
      body = await req.json();
    } catch (_) {
      // empty body fallback
    }

    const { action, ride, userId } = body as Record<string, any>;

  const mongoClient = await getMongoClient();
  const ridesCollection = mongoClient ? mongoClient.database("riderapp").collection("rides") : getInMemoryCollection();

    console.log("Action:", action, "User:", userId);

    switch (action) {
      case "CREATE_RIDE": {
        if (!ride) throw new Error("Ride details missing");

        const normalized = normalizeRideInput(ride);
        const rideDoc = {
          ...normalized,
          userId: userId || "anonymous",
          createdAt: new Date(),
          status: "active",
        };

        const result = await ridesCollection.insertOne(rideDoc);
        console.log("Ride created:", result);

        const insertedId = typeof result === "string" ? result : result?.toString?.() ?? null;

        return new Response(
          JSON.stringify({ success: true, id: insertedId, ride: { id: insertedId, ...rideDoc } }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "GET_MATCHED_RIDES": {
        const { pickup, dropoff, location } = ride || {};
        const allRides = await ridesCollection.find({ status: "active" }).toArray();

        const matchedRides = allRides
          .map((r: any) => {
            const rr = mapDbRideToResponse(r);
            let score = 0;

            if (pickup && rr.pickup) {
              const pickupMatch = calculateLocationMatch(
                String(pickup).toLowerCase(),
                String(rr.pickup).toLowerCase()
              );
              score += pickupMatch * 40;
            }

            if (dropoff && rr.dropoff) {
              const dropoffMatch = calculateLocationMatch(
                String(dropoff).toLowerCase(),
                String(rr.dropoff).toLowerCase()
              );
              score += dropoffMatch * 40;
            }

            // try to use profile/location if present
            const locA = location ?? rr.__raw?.location ?? (rr.__raw?.location_lat && rr.__raw?.location_lng ? `${rr.__raw.location_lat}, ${rr.__raw.location_lng}` : null);
            const locB = rr.__raw?.location ?? (rr.__raw?.location_lat && rr.__raw?.location_lng ? `${rr.__raw.location_lat}, ${rr.__raw.location_lng}` : null);

            if (locA && locB) {
              const distanceMatch = calculateDistanceMatch(locA, locB);
              score += distanceMatch * 20;
            }

            return {
              ...rr,
              matchScore: score,
            };
          })
          .filter((r: any) => r.matchScore > 30)
          .sort((a: any, b: any) => b.matchScore - a.matchScore);

        return new Response(
          JSON.stringify({ rides: matchedRides }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "GET_USER_RIDES": {
        const userRides = await ridesCollection
          .find({ userId, status: "active" })
          .sort({ createdAt: -1 })
          .toArray();

        const formattedRides = userRides.map((r: any) => mapDbRideToResponse(r));

        return new Response(
          JSON.stringify({ rides: formattedRides }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "DELETE_RIDE": {
        const { rideId } = ride || {};
        if (!rideId) throw new Error("Missing rideId");

        if (useInMemory) {
          await ridesCollection.updateOne({ id: rideId }, { $set: { status: "cancelled" } });
        } else {
          await ridesCollection.updateOne(
            { _id: new ObjectId(rideId) },
            { $set: { status: "cancelled" } }
          );
        }

        return new Response(
          JSON.stringify({ success: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      default:
        return new Response(
          JSON.stringify({
            error: "Invalid action or missing request body",
            expectedActions: [
              "CREATE_RIDE",
              "GET_MATCHED_RIDES",
              "GET_USER_RIDES",
              "DELETE_RIDE",
            ],
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
  } catch (error) {
    console.error("Error in ride-matching function:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// 🔍 Helper: fuzzy location text match
function calculateLocationMatch(str1: string, str2: string): number {
  const words1 = str1.split(/\s+/);
  const words2 = str2.split(/\s+/);
  let matchCount = 0;

  for (const w1 of words1) {
    if (words2.some((w2) => w2.includes(w1) || w1.includes(w2))) matchCount++;
  }

  return matchCount / Math.max(words1.length, words2.length);
}

// 📍 Helper: approximate distance match
function calculateDistanceMatch(loc1: string, loc2: string): number {
  const coords1 = loc1.split(",").map((c) => parseFloat(c.trim()));
  const coords2 = loc2.split(",").map((c) => parseFloat(c.trim()));

  if (coords1.length !== 2 || coords2.length !== 2 || coords1.some(isNaN) || coords2.some(isNaN))
    return 0;

  const R = 6371;
  const dLat = (coords2[0] - coords1[0]) * (Math.PI / 180);
  const dLon = (coords2[1] - coords1[1]) * (Math.PI / 180);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(coords1[0] * (Math.PI / 180)) *
      Math.cos(coords2[0] * (Math.PI / 180)) *
      Math.sin(dLon / 2) ** 2;

  const distance = R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));

  if (distance < 2) return 1.0;
  if (distance > 10) return 0;
  return 1 - (distance - 2) / 8;
}
