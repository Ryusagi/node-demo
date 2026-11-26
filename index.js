const express = require("express");
const nunjucks = require("nunjucks");
const { randomUUID } = require("crypto");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const { MongoClient } = require("mongodb");
const path = require("path");

require("dotenv").config();

const mongoUrl = process.env.MONGO_URL;
//test "mongodb://elizavetabelayamail_db_user:LFsLS5MuMJOTP7o3@ac-tfa6afe-shard-00-00.tx844a1.mongodb.net:27017,ac-tfa6afe-shard-00-01.tx844a1.mongodb.net:27017,ac-tfa6afe-shard-00-02.tx844a1.mongodb.net:27017/?ssl=true&replicaSet=atlas-4y2xeh-shard-0&authSource=admin";
const dbName = process.env.DB_NAME || "timers_db";

let client;
let db;
let users;
let sessions;
let timers;

const hash = (text) => text;

const USERS = [
  {
    id: randomUUID(),
    username: "admin",
    password: hash("pwd007"),
  },
];

// seed объявлен ДО connectMongo, чтобы его можно было вызвать сразу после очистки
const seed = async () => {
  await users.insertMany(USERS);

  const admin = await users.findOne({ username: "admin" });
  if (!admin) return;

  const TIMERS = [
    {
      id: randomUUID(),
      user_id: admin.id,
      start: Date.now(),
      description: "Timer 1",
      is_active: true,
    },
    {
      id: randomUUID(),
      user_id: admin.id,
      start: Date.now() - 5000,
      end: Date.now() - 3000,
      duration: 2000,
      description: "Timer 0",
      is_active: false,
    },
  ];

  await timers.insertMany(TIMERS);
};

const connectMongo = async () => {
  if (db) return;

  client = new MongoClient(mongoUrl);
  await client.connect();
  db = client.db(dbName);

  users = db.collection("users");
  sessions = db.collection("sessions");
  timers = db.collection("timers");

  await users.deleteMany({});
  await sessions.deleteMany({});
  await timers.deleteMany({});

  // индексы
  /*await users.createIndex({ id: 1 }, { unique: true });
  await users.createIndex({ username: 1 }, { unique: true });
  await sessions.createIndex({ id: 1 }, { unique: true });
  await timers.createIndex({ id: 1 }, { unique: true });
  await timers.createIndex({ user_id: 1 });
  */

  // сид сразу после очистки
  await seed();
};

const findUserByUsername = async (username) => users.findOne({ username });

const findUserById = async (id) => users.findOne({ id });

const findUserBySessionId = async (sessionId) => {
  const session = await sessions.findOne({ id: sessionId });
  if (!session || !session.user_id) return;
  return findUserById(session.user_id);
};

const createUser = async (username, password) => {
  const id = randomUUID();
  await users.insertOne({ id, username, password });
  return id;
};

const createSession = async (userId) => {
  const id = randomUUID();
  await sessions.insertOne({ id, user_id: userId });
  return id;
};

const deleteSession = async (sessionId) => {
  await sessions.deleteOne({ id: sessionId });
};

const auth = () => async (req, res, next) => {
  if (!req.cookies["sessionId"]) return next();
  try {
    const user = await findUserBySessionId(req.cookies["sessionId"]);
    req.user = user;
    req.sessionId = req.cookies["sessionId"];
    next();
  } catch (err) {
    next(err);
  }
};

const requireAuth = () => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

const getError = (query) => {
  const { authError, signupError, emptySignupError } = query;
  if (authError === "true") return "Wrong username or password";
  if (signupError === "true") return "User already exists";
  if (emptySignupError === "true") return "Password is empty";
  return "";
};

const router = express.Router();
const urlencoded = bodyParser.urlencoded({ extended: false });

router.get("/", auth(), (req, res) => {
  res.render("index", {
    user: req.user,
    authError: getError(req.query),
  });
});

router.post("/login", urlencoded, async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const user = await findUserByUsername(username);

    if (!user || user.password !== password) {
      return res.redirect("/?authError=true");
    }
    const sessionId = await createSession(user.id);
    res.cookie("sessionId", sessionId, { httpOnly: true }).redirect("/");
  } catch (err) {
    next(err);
  }
});

router.get("/logout", auth(), async (req, res, next) => {
  try {
    if (!req.user) return res.redirect("/");
    await deleteSession(req.sessionId);
    res.clearCookie("sessionId").redirect("/");
  } catch (err) {
    next(err);
  }
});

router.post("/signup", urlencoded, async (req, res, next) => {
  try {
    const { username, password } = req.body;

    if (!password) return res.redirect("/?emptySignupError=true");

    const user = await findUserByUsername(username);

    if (user) return res.redirect("/?signupError=true");

    const userId = await createUser(username, password);
    const sessionId = await createSession(userId);
    res.cookie("sessionId", sessionId, { httpOnly: true }).redirect("/");
  } catch (err) {
    next(err);
  }
});

router.get("/api/timers", auth(), requireAuth(), async (req, res, next) => {
  try {
    const filter = { user_id: req.user.id };
    if (req.query.isActive !== undefined) {
      filter.is_active = req.query.isActive === "true";
    }

    const list = await timers.find(filter).toArray();

    if (req.query.isActive === "true") {
      list.forEach((t) => {
        t.progress = Date.now() - Number(t.start);
      });
    }

    res.json(list);
  } catch (err) {
    next(err);
  }
});

router.post("/api/timers", auth(), requireAuth(), async (req, res, next) => {
  try {
    const { description } = req.body ?? {};
    if (!description || typeof description !== "string" || !description.trim()) {
      return res.status(400).json({ error: "description is required" });
    }

    const id = randomUUID();
    await timers.insertOne({
      id,
      user_id: req.user.id,
      start: Date.now(),
      description: description.trim(),
      is_active: true,
    });

    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

router.post("/api/timers/:id/stop", auth(), requireAuth(), async (req, res, next) => {
  try {
    const { id } = req.params;
    const timer = await timers.findOne({ id, user_id: req.user.id });
    if (!timer) {
      return res.status(404).json({ error: "Timer not found" });
    }

    const now = Date.now();
    await timers.updateOne(
      { id },
      {
        $set: {
          is_active: false,
          end: now,
          duration: now - Number(timer.start),
        },
      }
    );

    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

const app = express();

app.set("view engine", "njk");
app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));

nunjucks.configure(path.join(__dirname, "views"), {
  autoescape: true,
  express: app,
  tags: {
    blockStart: "[%",
    blockEnd: "%]",
    variableStart: "[[",
    variableEnd: "]]",
    commentStart: "[#",
    commentEnd: "#]",
  },
});

app.use(cookieParser());

app.use(async (req, res, next) => {
  try {
    await connectMongo();
    next();
  } catch (err) {
    console.error("Database connection error:", err);
    res.status(500).json({ error: "Database connection failed" });
  }
});

app.use(router);

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Internal server error" });
});

if (process.env.NODE_ENV !== "production") {
  const port = process.env.PORT || 3000;
  (async () => {
    try {
      await connectMongo();
      app.listen(port, () => {
        console.log(`  Listening on http://localhost:${port}`);
      });
    } catch (err) {
      console.error("Failed to initialize database:", err);
      process.exit(1);
    }
  })();
}

module.exports = app;
