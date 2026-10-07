FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY global.json ./
COPY backend/CampusNexa.Api/CampusNexa.Api.csproj backend/CampusNexa.Api/packages.lock.json ./backend/CampusNexa.Api/
RUN dotnet restore backend/CampusNexa.Api --locked-mode
COPY backend/CampusNexa.Api ./backend/CampusNexa.Api
RUN dotnet publish backend/CampusNexa.Api -c Release --no-restore -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
RUN mkdir -p /data/keys && chown -R $APP_UID:$APP_UID /data
COPY --from=build /app .
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["dotnet", "CampusNexa.Api.dll"]
