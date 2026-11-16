import { describe, expect, it } from 'vitest';
import {
  extractContracts,
  matchContractIdentifiers,
  normalizeRoutePath,
  normalizeTableName,
} from './contracts.ts';
import type { Contract } from './types.ts';

const ids = (list: Contract[], kind: Contract['kind'], role?: Contract['role']) =>
  list
    .filter((c) => c.kind === kind && (!role || c.role === role))
    .map((c) => c.identifier)
    .sort();

describe('normalizeRoutePath', () => {
  it.each([
    ['/users/:id', '/users/:param'],
    ['/users/{id}', '/users/:param'],
    ['users/<int:id>/', '/users/:param'],
    ['/posts/[slug]', '/posts/:param'],
    ['https://api.example.com/v1/users?x=1', '/v1/users'],
    ['${BASE_URL}/orders/${id}', '/orders/:param'],
    ['^api/items/(?P<pk>[0-9]+)/$', '/api/items/:param'],
    ['//a///b/', '/a/b'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeRoutePath(input)).toBe(expected);
  });
  it('rejects non-paths', () => {
    expect(normalizeRoutePath('${url}')).toBeNull();
    expect(normalizeRoutePath('hello world')).toBeNull();
  });
});

describe('matchContractIdentifiers', () => {
  it('matches exact, ANY method and mount-prefix suffixes', () => {
    expect(matchContractIdentifiers('http_route', 'GET /users/:param', 'GET /users/:param')).toBe(
      'exact',
    );
    expect(matchContractIdentifiers('http_route', 'ANY /users', 'POST /users')).toBe('exact');
    expect(matchContractIdentifiers('http_route', 'GET /users', 'POST /users')).toBeNull();
    expect(
      matchContractIdentifiers('http_route', 'GET /api/v1/users/:param', 'GET /users/:param'),
    ).toBeNull(); // one static segment
    expect(
      matchContractIdentifiers('http_route', 'GET /api/orders/items', 'GET /orders/items'),
    ).toBe('suffix');
    expect(matchContractIdentifiers('env_var', 'DB_URL', 'db_url')).toBe('exact');
  });
});

describe('HTTP providers', () => {
  it('express / koa style routers', () => {
    const src = `import express from 'express';
const app = express();
const router = express.Router();
app.get('/health', (req, res) => res.send('ok'));
router.post("/users/:id/roles", handler);
router.route('/items').get(list);
app.set('view engine', 'ejs');
`;
    const c = extractContracts('src/server.ts', src);
    expect(ids(c, 'http_route', 'provider')).toEqual([
      'ANY /items',
      'GET /health',
      'POST /users/:param/roles',
    ]);
  });

  it('fastify route objects and NestJS controllers', () => {
    const f = extractContracts(
      'src/app.ts',
      `import Fastify from 'fastify';\nfastify.route({\n  method: ['GET', 'HEAD'],\n  url: '/status',\n  handler,\n});\n`,
    );
    expect(ids(f, 'http_route')).toEqual(['GET /status', 'HEAD /status']);
    const nest = extractContracts(
      'src/users.controller.ts',
      `@Controller('users')\nexport class UsersController {\n  @Get(':id')\n  find() {}\n  @Post()\n  create() {}\n}\n`,
    );
    expect(ids(nest, 'http_route', 'provider')).toEqual(['GET /users/:param', 'POST /users']);
  });

  it('Next.js app router handlers', () => {
    const c = extractContracts(
      'app/api/orders/[id]/route.ts',
      `export async function GET(req: Request) {}\nexport const DELETE = async () => {};\n`,
    );
    expect(ids(c, 'http_route')).toEqual(['DELETE /api/orders/:param', 'GET /api/orders/:param']);
  });

  it('Flask, FastAPI and Django', () => {
    const flask = extractContracts(
      'app/views.py',
      `bp = Blueprint("users", __name__, url_prefix="/users")\n@bp.route("/<int:id>", methods=["GET", "DELETE"])\ndef user(id):\n    pass\n`,
    );
    expect(ids(flask, 'http_route')).toEqual(['DELETE /users/:param', 'GET /users/:param']);
    const fastapi = extractContracts(
      'app/api.py',
      `router = APIRouter(prefix="/items")\n@router.get("/{item_id}")\nasync def read(item_id: int):\n    ...\n@app.post('/login')\ndef login(): ...\n`,
    );
    expect(ids(fastapi, 'http_route')).toEqual(['GET /items/:param', 'POST /login']);
    const django = extractContracts(
      'shop/urls.py',
      `urlpatterns = [\n    path('orders/<int:pk>/', views.detail),\n    path('api/', include('api.urls')),\n]\n`,
    );
    expect(ids(django, 'http_route')).toEqual(['ANY /orders/:param']);
  });

  it('Gin, Echo, chi and net/http', () => {
    const src = `package main
func routes(r *gin.Engine) {
	v1 := r.Group("/v1")
	v1.GET("/users/:id", getUser)
	r.POST("/login", login)
	mux.HandleFunc("GET /healthz", health)
	m.HandleFunc("/items", items).Methods("PUT")
	resp, err := http.Get("https://billing.internal/v2/invoices")
	req, _ := http.NewRequest(http.MethodPost, "https://billing.internal/v2/charges", body)
}
`;
    const c = extractContracts('cmd/main.go', src);
    expect(ids(c, 'http_route', 'provider')).toEqual([
      'GET /healthz',
      'GET /v1/users/:param',
      'POST /login',
      'PUT /items',
    ]);
    expect(ids(c, 'http_route', 'consumer')).toEqual(['GET /v2/invoices', 'POST /v2/charges']);
  });

  it('Spring MVC and JAX-RS', () => {
    const spring = `@RestController
@RequestMapping("/api/accounts")
public class AccountController {
    @GetMapping("/{id}")
    public Account get(@PathVariable String id) { return null; }

    @PostMapping
    public Account create(@RequestBody Account a) { return a; }

    @RequestMapping(value = "/search", method = RequestMethod.POST)
    public List<Account> search() { return null; }
}
`;
    expect(
      ids(extractContracts('src/main/java/AccountController.java', spring), 'http_route'),
    ).toEqual(['GET /api/accounts/:param', 'POST /api/accounts', 'POST /api/accounts/search']);
    const jax = `@Path("/orders")
public class OrderResource {
    @GET
    @Path("/{id}")
    public Order get() { return null; }
}
`;
    expect(ids(extractContracts('OrderResource.java', jax), 'http_route')).toEqual([
      'GET /orders/:param',
    ]);
  });

  it('Rails routes and Laravel', () => {
    expect(
      ids(
        extractContracts(
          'config/routes.rb',
          `Rails.application.routes.draw do\n  get '/status', to: 'health#show'\n  resources :invoices\nend\n`,
        ),
        'http_route',
      ),
    ).toEqual(['ANY /invoices', 'GET /status']);
    expect(
      ids(
        extractContracts(
          'routes/api.php',
          `<?php\nRoute::get('/users/{id}', [UserController::class, 'show']);\n`,
        ),
        'http_route',
      ),
    ).toEqual(['GET /users/:param']);
  });
});

describe('HTTP consumers', () => {
  it('fetch / axios / http clients', () => {
    const src = `const r = await fetch(\`\${API_URL}/users/\${id}\`);
await fetch('/api/orders', {
  method: 'POST',
  body,
});
axios.delete('/api/orders/' + id);
this.http.get<User[]>('/api/users');
const v = cache.get('/not-a-route-call');
`;
    const c = extractContracts('web/src/api.ts', src);
    expect(ids(c, 'http_route', 'consumer')).toEqual([
      'DELETE /api/orders/:param',
      'GET /api/users',
      'GET /users/:param',
      'POST /api/orders',
    ]);
    expect(ids(c, 'http_route', 'provider')).toEqual([]);
  });

  it('python requests and java RestTemplate', () => {
    expect(
      ids(
        extractContracts('client.py', `resp = requests.get(f"https://svc/api/users/{uid}")\n`),
        'http_route',
        'consumer',
      ),
    ).toEqual(['GET /api/users/:param']);
    expect(
      ids(
        extractContracts(
          'Client.java',
          `restTemplate.postForObject("http://orders/api/orders", req, Order.class);\n`,
        ),
        'http_route',
        'consumer',
      ),
    ).toEqual(['POST /api/orders']);
  });

  it('ignores commented-out code', () => {
    expect(
      extractContracts('a.ts', `// app.get('/old', h)\n/*\napp.post('/older', h)\n*/\n`),
    ).toEqual([]);
  });
});

describe('GraphQL', () => {
  const sdl = `type Query {
  user(id: ID!): User
  users(
    first: Int
    after: String
  ): [User!]!
}

type User implements Node {
  id: ID!
  email: String! @deprecated(reason: "no")
}

enum Role {
  ADMIN
  MEMBER
}

input CreateUser { email: String! }
`;
  it('extracts types, fields with signatures and enum values', () => {
    const c = extractContracts('schema/schema.graphql', sdl);
    expect(ids(c, 'graphql')).toEqual([
      'CreateUser',
      'Query',
      'Query.user',
      'Query.users',
      'Role',
      'Role.ADMIN',
      'Role.MEMBER',
      'User',
      'User.email',
      'User.id',
    ]);
    expect(c.find((x) => x.identifier === 'Query.user')?.signature).toBe('(id:ID!):User');
    expect(c.find((x) => x.identifier === 'Query.users')?.signature).toBe(
      '(first:Int after:String):[User!]!',
    );
    expect(c.find((x) => x.identifier === 'User.email')?.signature).toBe(':String!');
  });

  it('extracts SDL embedded in gql template literals', () => {
    const c = extractContracts(
      'src/schema.ts',
      `export const typeDefs = gql\`\n  type Product {\n    sku: String!\n  }\n\`;\n`,
    );
    expect(ids(c, 'graphql')).toEqual(['Product', 'Product.sku']);
    expect(c.find((x) => x.identifier === 'Product.sku')?.line).toBe(3);
  });
});

describe('protobuf', () => {
  it('extracts services, rpcs, messages, fields and enum values', () => {
    const proto = `syntax = "proto3";
package billing.v1;

service Invoices {
  rpc GetInvoice (GetInvoiceRequest) returns (Invoice);
  rpc Watch (WatchRequest) returns (stream Invoice);
}

message Invoice {
  string id = 1;
  repeated LineItem items = 2;
  map<string, string> labels = 3;
  oneof payer {
    string user_id = 4;
  }
  message LineItem {
    int64 cents = 1;
  }
}

enum Status {
  STATUS_UNSPECIFIED = 0;
  PAID = 1;
}
`;
    const c = extractContracts('proto/billing.proto', proto);
    const get = (id: string) => c.find((x) => x.identifier === id);
    expect(get('billing.v1.Invoices.GetInvoice')?.signature).toBe(
      '(GetInvoiceRequest) returns (Invoice)',
    );
    expect(get('billing.v1.Invoices.Watch')?.signature).toBe(
      '(WatchRequest) returns (stream Invoice)',
    );
    expect(get('billing.v1.Invoice.id')?.signature).toBe('string = 1');
    expect(get('billing.v1.Invoice.items')?.signature).toBe('repeated LineItem = 2');
    expect(get('billing.v1.Invoice.labels')?.signature).toBe('map<string,string> = 3');
    expect(get('billing.v1.Invoice.user_id')?.signature).toBe('string = 4 (oneof)');
    expect(get('billing.v1.Invoice.LineItem.cents')?.signature).toBe('int64 = 1');
    expect(get('billing.v1.Status.PAID')?.signature).toBe('= 1');
    expect(get('billing.v1.Status')).toBeDefined();
  });
});

describe('env vars', () => {
  it('reads across languages', () => {
    expect(
      ids(
        extractContracts(
          'a.ts',
          `const u = process.env.DATABASE_URL;\nconst k = process.env['API_KEY'];\nconst { PORT, HOST: h = '0' } = process.env;\nimport.meta.env.VITE_URL;\n`,
        ),
        'env_var',
      ),
    ).toEqual(['API_KEY', 'DATABASE_URL', 'HOST', 'PORT', 'VITE_URL']);
    expect(
      ids(
        extractContracts(
          'a.py',
          `os.environ["A"]\nos.environ.get('B')\nos.getenv("C", "x")\nenv('D')\n`,
        ),
        'env_var',
      ),
    ).toEqual(['A', 'B', 'C', 'D']);
    expect(
      ids(
        extractContracts('a.go', `x := os.Getenv("REDIS_URL")\nv, ok := os.LookupEnv("MODE")\n`),
        'env_var',
      ),
    ).toEqual(['MODE', 'REDIS_URL']);
    expect(
      ids(extractContracts('A.java', `String s = System.getenv("JAVA_HOME_X");\n`), 'env_var'),
    ).toEqual(['JAVA_HOME_X']);
    expect(
      ids(extractContracts('a.rb', `ENV['RAILS_X']\nENV.fetch("RAILS_Y") { 1 }\n`), 'env_var'),
    ).toEqual(['RAILS_X', 'RAILS_Y']);
  });

  it('definitions in .env, Dockerfile and compose/k8s yaml are providers', () => {
    expect(
      ids(
        extractContracts(
          '.env.example',
          `# comment\nDATABASE_URL=postgres://x\nexport SECRET_KEY=\n`,
        ),
        'env_var',
        'provider',
      ),
    ).toEqual(['DATABASE_URL', 'SECRET_KEY']);
    expect(
      ids(
        extractContracts(
          'Dockerfile',
          `FROM node:22\nENV NODE_ENV=production PORT=3000\nARG BUILD_SHA\n`,
        ),
        'env_var',
        'provider',
      ),
    ).toEqual(['BUILD_SHA', 'NODE_ENV', 'PORT']);
    const compose = `services:
  api:
    image: x
    environment:
      LOG_LEVEL: info
      - FEATURE_X=1
    ports:
      - "3000:3000"
`;
    expect(ids(extractContracts('docker-compose.yml', compose), 'env_var')).toEqual([
      'FEATURE_X',
      'LOG_LEVEL',
    ]);
    const k8s = `spec:\n  containers:\n    - env:\n        - name: QUEUE_URL\n          value: x\n        - name: lowercase_ignored\n`;
    expect(ids(extractContracts('k8s/deploy.yaml', k8s), 'env_var')).toEqual(['QUEUE_URL']);
  });
});

describe('database tables', () => {
  it('SQL DDL and DML', () => {
    const c = extractContracts(
      'db/migrations/001.sql',
      `CREATE TABLE IF NOT EXISTS public."Users" (id int);\nALTER TABLE orders ADD COLUMN x int;\n-- DROP TABLE commented;\nSELECT * FROM invoices i JOIN customers c ON c.id = i.cid;\n`,
    );
    expect(ids(c, 'db_table', 'provider')).toEqual(['orders', 'users']);
    expect(ids(c, 'db_table', 'consumer')).toEqual(['customers', 'invoices']);
  });

  it('ORM schemas', () => {
    expect(
      ids(
        extractContracts(
          'prisma/schema.prisma',
          `model User {\n  id Int @id\n  @@map("app_users")\n}\nmodel Post {\n  id Int @id\n}\n`,
        ),
        'db_table',
      ),
    ).toEqual(['app_users', 'post']);
    expect(
      ids(
        extractContracts(
          'src/db/schema.ts',
          `export const users = pgTable('users', { id: uuid('id') });\n`,
        ),
        'db_table',
      ),
    ).toEqual(['users']);
    expect(
      ids(
        extractContracts(
          'src/user.entity.ts',
          `@Entity()\nexport class UserProfile {}\n@Entity('audit_log')\nclass A {}\n`,
        ),
        'db_table',
      ),
    ).toEqual(['audit_log', 'user_profile']);
    expect(
      ids(
        extractContracts(
          'app/models.py',
          `class Order(models.Model):\n    total = models.IntegerField()\n\nclass Item(models.Model):\n    class Meta:\n        db_table = "shop_items"\n`,
        ),
        'db_table',
      ),
    ).toEqual(['order', 'shop_items']);
    expect(
      ids(
        extractContracts(
          'app/models/user_account.rb',
          `class UserAccount < ApplicationRecord\nend\n`,
        ),
        'db_table',
      ),
    ).toEqual(['user_accounts']);
    expect(
      ids(
        extractContracts('models.py', `class T(Base):\n    __tablename__ = "tokens"\n`),
        'db_table',
      ),
    ).toEqual(['tokens']);
  });

  it('raw SQL in code strings is a consumer; python imports are not', () => {
    const c = extractContracts(
      'repo.py',
      `from datetime import datetime\nfrom app import db\ncur.execute("SELECT id FROM payments WHERE id = %s", (pid,))\n`,
    );
    expect(ids(c, 'db_table')).toEqual(['payments']);
  });

  it('normalizeTableName', () => {
    expect(normalizeTableName('`shop`.`Orders`')).toBe('orders');
    expect(normalizeTableName('select')).toBeNull();
  });
});

describe('queues & events', () => {
  it('extracts producers and consumers', () => {
    const js = `await producer.send({ topic: 'orders.created', messages });
await consumer.subscribe({ topics: ['payments.settled'] });
const q = new Queue('emails');
new Worker('emails', handler);
await boss.send('pr.analyze', data);
await boss.work('pr.analyze', h);
`;
    const c = extractContracts('src/jobs.ts', js);
    expect(ids(c, 'queue_topic', 'provider')).toEqual(['emails', 'orders.created', 'pr.analyze']);
    expect(ids(c, 'queue_topic', 'consumer')).toEqual(['emails', 'payments.settled', 'pr.analyze']);
    const java = `@KafkaListener(topics = {"a.b", "c.d"}, groupId = "g")\npublic void on(String m) {}\nkafkaTemplate.send("out.topic", m);\n@RabbitListener(queues = "jobs")\n`;
    const j = extractContracts('L.java', java);
    expect(ids(j, 'queue_topic', 'consumer')).toEqual(['a.b', 'c.d', 'jobs']);
    expect(ids(j, 'queue_topic', 'provider')).toEqual(['out.topic']);
  });

  it('does not treat arbitrary .on() handlers as events', () => {
    expect(extractContracts('a.ts', `button.on('click', h);\nsocket.on('data', d);\n`)).toEqual([]);
  });
});
