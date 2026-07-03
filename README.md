# Streaming Service

A TypeScript Express.js streaming service with comprehensive setup and testing infrastructure.

## 🚀 Features

- **TypeScript**: Full TypeScript support with strict type checking
- **Express.js**: Fast, unopinionated web framework
- **Security**: Helmet.js for security headers
- **CORS**: Cross-Origin Resource Sharing enabled
- **Logging**: Morgan for HTTP request logging
- **Testing**: Jest with TypeScript support
- **Linting**: ESLint with TypeScript rules
- **Environment**: Dotenv for environment variable management

## API documentation

When the service is running:

- **Swagger UI**: `http://localhost:{PORT}/api-docs` — interactive API documentation
- **OpenAPI spec**: `http://localhost:{PORT}/api-docs.json` — machine-readable specification

The root `GET /` response also lists `apiDocs` and `openApiSpec` paths. Streaming endpoints are also documented on the app-service proxy at `/api/v1/stream/*` (kept in sync).

## 📋 Prerequisites

- Node.js **26.4.0**
- npm **11.17.0** (run `nvm use` / `fnm use` in this directory to match `.nvmrc`)

## 🛠️ Installation

1. **Clone the repository** (if not already done)

   ```bash
   git clone <your-repo-url>
   cd streaming-service
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp env.example .env
   ```
   Edit `.env` file with your configuration.

## 🏃‍♂️ Running the Application

### Development Mode

```bash
npm run dev
```

This will start the server with hot reload using `ts-node-dev`.

### Production Mode

```bash
npm run build
npm start
```

The server will start on port **8082** by default (configurable via `PORT` environment variable).

## 🧪 Testing

### Run all tests

```bash
npm test
```

### Run tests in watch mode

```bash
npm run test:watch
```

### Run tests with coverage

```bash
npm test -- --coverage
```

## 🔍 Code Quality

### Linting

```bash
npm run lint
```

### Fix linting issues

```bash
npm run lint:fix
```

## 📁 Project Structure

```
streaming-service/
├── src/
│   └── index.ts          # Main server file
├── tests/
│   ├── index.test.ts     # Main test file
│   └── setup.ts          # Test setup configuration
├── dist/                 # Compiled JavaScript (generated)
├── coverage/             # Test coverage reports (generated)
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript configuration
├── jest.config.js        # Jest testing configuration
├── .eslintrc.js          # ESLint configuration
├── .gitignore           # Git ignore rules
└── README.md            # This file
```

## 🌐 API Endpoints

### Health Check

- **GET** `/health` - Returns server health status

### Root

- **GET** `/` - Returns API information

### API

- **GET** `/api` - Placeholder for API endpoints

## 🔧 Configuration

### Environment Variables

| Variable   | Description      | Default       |
| ---------- | ---------------- | ------------- |
| `NODE_ENV` | Environment mode | `development` |
| `PORT`     | Server port      | `8082`        |

### TypeScript Configuration

The project uses strict TypeScript configuration with:

- Strict type checking enabled
- Source maps for debugging
- Declaration files generation
- Path mapping for clean imports

## 🚀 Deployment

1. **Build the application**

   ```bash
   npm run build
   ```

2. **Set production environment**

   ```bash
   export NODE_ENV=production
   ```

3. **Start the server**
   ```bash
   npm start
   ```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Run tests and linting
6. Submit a pull request

## 📝 License

This project is licensed under the MIT License.

## 🆘 Support

If you encounter any issues or have questions, please create an issue in the repository.
